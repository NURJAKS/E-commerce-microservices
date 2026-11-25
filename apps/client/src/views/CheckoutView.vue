<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import type {
  InvoiceDownloadResponse,
  OrderDto,
  OrderStatusUpdatedWsPayload,
  PaymentDto,
} from '@shop/contracts';
import { http } from '../api/http';
import { socketManager } from '../services/socket';

const route = useRoute();
const order = ref<OrderDto | null>(null);
const payment = ref<PaymentDto | null>(null);
const loading = ref(true);
const refundReason = ref('');
const refundLoading = ref(false);
const refundError = ref<string | null>(null);
const invoiceLoading = ref(false);
const invoiceError = ref<string | null>(null);
const wsEvents = ref<OrderStatusUpdatedWsPayload[]>([]);

let unsubscribeWs: (() => void) | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

const orderId = computed(() => String(route.params.id));

async function fetchOrderState() {
  try {
    const { data } = await http.get<OrderDto>(`/orders/${orderId.value}`);
    order.value = data;
    if (
      data.status === 'PENDING' ||
      data.status === 'PAID' ||
      data.status === 'FAILED' ||
      data.status === 'REFUNDING' ||
      data.status === 'REFUNDED'
    ) {
      try {
        const payRes = await http.get<PaymentDto>(
          `/orders/${orderId.value}/payment`,
        );
        payment.value = payRes.data;
      } catch {
        // Ignore if payment record not yet available
      }
    }
    if (data.status !== 'PENDING' && data.status !== 'REFUNDING' && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  } finally {
    loading.value = false;
  }
}

async function handleDownloadInvoice() {
  if (!order.value || invoiceLoading.value) return;
  invoiceLoading.value = true;
  invoiceError.value = null;
  try {
    const { data } = await http.get<InvoiceDownloadResponse>(
      `/orders/${order.value.id}/invoice`,
    );
    window.open(data.downloadUrl, '_blank', 'noopener,noreferrer');
  } catch (err: any) {
    invoiceError.value =
      err?.response?.data?.message || 'Failed to generate PDF receipt link';
  } finally {
    invoiceLoading.value = false;
  }
}

async function handleRequestRefund() {
  if (!order.value || order.value.status !== 'PAID' || refundLoading.value) {
    return;
  }
  refundLoading.value = true;
  refundError.value = null;
  try {
    const idempotencyKey =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `refund-${Date.now()}`;
    const { data } = await http.post<OrderDto>(
      `/orders/${order.value.id}/refund`,
      { reason: refundReason.value.trim() || undefined },
      { headers: { 'X-Idempotency-Key': idempotencyKey } },
    );
    order.value = data;
    if (!pollTimer) {
      pollTimer = setInterval(fetchOrderState, 600);
    }
  } catch (err: any) {
    refundError.value =
      err?.response?.data?.message || 'Failed to request refund';
  } finally {
    refundLoading.value = false;
  }
}

onMounted(async () => {
  await fetchOrderState();

  unsubscribeWs = socketManager.onOrderStatusUpdated(async (payload) => {
    if (payload.orderId === orderId.value) {
      wsEvents.value.unshift(payload);
      if (order.value) {
        order.value.status = payload.status;
      }
      await fetchOrderState();
    }
  });

  // Poll every 600ms while PENDING or REFUNDING in case the fast Saga finished during route transition
  if (
    order.value?.status === 'PENDING' ||
    order.value?.status === 'REFUNDING'
  ) {
    pollTimer = setInterval(fetchOrderState, 600);
  }
});

onUnmounted(() => {
  if (unsubscribeWs) unsubscribeWs();
  if (pollTimer) clearInterval(pollTimer);
});

const statusLabel = computed(() => {
  if (!order.value) return '';
  switch (order.value.status) {
    case 'PAID':
      return 'Paid (PAID)';
    case 'REFUNDING':
      return 'Processing Refund (REFUNDING)';
    case 'REFUNDED':
      return 'Refunded & Restocked (REFUNDED)';
    case 'FAILED':
      return 'Payment Failed — Stock Restored (FAILED)';
    case 'CANCELLED':
      return 'Cancelled (CANCELLED)';
    default:
      return 'Processing Saga (PENDING)';
  }
});
</script>

<template>
  <div v-if="loading" class="py-16 text-center text-slate-400">
    Loading order &amp; Saga state...
  </div>

  <div v-else-if="order" class="max-w-3xl mx-auto space-y-6">
    <!-- Order Header Card -->
    <div
      class="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 sm:p-8 space-y-6"
    >
      <div
        class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-slate-800 pb-6"
      >
        <div>
          <span class="text-xs font-semibold uppercase tracking-wider text-indigo-400">
            Choreography Saga Order
          </span>
          <h1 class="mt-1 text-2xl font-extrabold text-white">
            Order #{{ order.id.slice(0, 8) }}
          </h1>
          <p class="text-xs text-slate-400 mt-0.5">
            Created {{ new Date(order.createdAt).toLocaleString() }}
          </p>
        </div>

        <span
          data-testid="order-status-badge"
          class="inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold border"
          :class="{
            'border-emerald-500/40 bg-emerald-500/15 text-emerald-300':
              order.status === 'PAID',
            'border-amber-500/40 bg-amber-500/15 text-amber-300 animate-pulse':
              order.status === 'PENDING' || order.status === 'REFUNDING',
            'border-violet-500/40 bg-violet-500/15 text-violet-300':
              order.status === 'REFUNDED',
            'border-rose-500/40 bg-rose-500/15 text-rose-300':
              order.status === 'FAILED' || order.status === 'CANCELLED',
          }"
        >
          {{ statusLabel }}
        </span>
      </div>

      <!-- Visual Choreography Saga Pipeline -->
      <div class="space-y-3">
        <h3 class="text-xs font-bold uppercase tracking-wider text-slate-400">
          RabbitMQ Topic Exchange (`shop.events`) Saga Flow
        </h3>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div
            class="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-3.5"
          >
            <div class="text-xs font-bold text-emerald-400">
              1. order.created
            </div>
            <p class="mt-1 text-[11px] text-slate-300">
              Order saved (PENDING) &amp; Redis cart cleared
            </p>
          </div>

          <div
            class="rounded-xl border p-3.5"
            :class="
              order.status === 'CANCELLED'
                ? 'border-rose-500/30 bg-rose-950/20'
                : 'border-emerald-500/30 bg-emerald-950/20'
            "
          >
            <div
              class="text-xs font-bold"
              :class="
                order.status === 'CANCELLED'
                  ? 'text-rose-400'
                  : 'text-emerald-400'
              "
            >
              2. catalog.stock.*
            </div>
            <p class="mt-1 text-[11px] text-slate-300">
              {{
                order.status === 'CANCELLED'
                  ? 'Out of stock rejection'
                  : 'Atomic SQL stock reserved'
              }}
            </p>
          </div>

          <div
            class="rounded-xl border p-3.5"
            :class="{
              'border-emerald-500/30 bg-emerald-950/20':
                order.status === 'PAID',
              'border-rose-500/30 bg-rose-950/20': order.status === 'FAILED',
              'border-slate-800 bg-slate-950/40':
                order.status === 'PENDING' || order.status === 'CANCELLED',
            }"
          >
            <div
              class="text-xs font-bold"
              :class="{
                'text-emerald-400': order.status === 'PAID',
                'text-rose-400': order.status === 'FAILED',
                'text-slate-400':
                  order.status === 'PENDING' || order.status === 'CANCELLED',
              }"
            >
              3. payment.*
            </div>
            <p class="mt-1 text-[11px] text-slate-300">
              {{
                order.status === 'PAID'
                  ? `Tx: ${payment?.transactionId || 'Confirmed'}`
                  : order.status === 'FAILED'
                    ? 'Declined -> Stock Compensated'
                    : 'Awaiting gateway'
              }}
            </p>
          </div>

          <div
            class="rounded-xl border p-3.5"
            :class="{
              'border-emerald-500/30 bg-emerald-950/20':
                order.status === 'PAID',
              'border-rose-500/30 bg-rose-950/20':
                order.status === 'FAILED' || order.status === 'CANCELLED',
              'border-slate-800 bg-slate-950/40': order.status === 'PENDING',
            }"
          >
            <div
              class="text-xs font-bold"
              :class="{
                'text-emerald-400': order.status === 'PAID',
                'text-rose-400':
                  order.status === 'FAILED' || order.status === 'CANCELLED',
                'text-slate-400': order.status === 'PENDING',
              }"
            >
              4. Notification
            </div>
            <p class="mt-1 text-[11px] text-slate-300">
              Mailpit SMTP email + WebSocket push
            </p>
          </div>
        </div>
      </div>

      <!-- Order Line Items -->
      <div class="space-y-3 border-t border-slate-800 pt-6">
        <h3 class="text-sm font-bold text-white">Order Items</h3>
        <div
          v-for="item in order.items"
          :key="item.id"
          class="flex items-center justify-between rounded-xl border border-slate-800/80 bg-slate-950/50 px-4 py-3 text-sm"
        >
          <div>
            <span class="font-semibold text-white">{{
              item.productTitle
            }}</span>
            <span class="ml-2 text-xs text-slate-400"
              >× {{ item.quantity }}</span
            >
          </div>
          <span class="font-bold text-slate-200">
            ${{ (Number(item.unitPrice) * item.quantity).toFixed(2) }}
          </span>
        </div>

        <div class="flex items-center justify-between pt-3 text-base font-bold text-white">
          <div>
            <span>Total Paid</span>
            <span
              v-if="order.discountCode"
              class="ml-2 rounded bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300"
            >
              Promo: {{ order.discountCode }}
            </span>
          </div>
          <span class="text-xl text-indigo-400" data-testid="order-total-amount">
            ${{ Number(order.totalAmount).toFixed(2) }}
          </span>
        </div>

        <!-- Private MinIO PDF Receipt Download (60s Presigned GET URL) -->
        <div
          v-if="
            order.status === 'PAID' ||
            order.status === 'REFUNDING' ||
            order.status === 'REFUNDED'
          "
          class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-500/30 bg-emerald-950/20 px-4 py-3"
        >
          <div class="text-xs text-emerald-200">
            <span class="font-bold">Official PDF Receipt</span>
            <span class="block text-[11px] text-slate-400">
              Stored in private MinIO bucket — downloaded via IDOR-checked 60s
              Presigned GET URL.
            </span>
          </div>
          <button
            data-testid="download-invoice-pdf-btn"
            :disabled="invoiceLoading"
            @click="handleDownloadInvoice"
            class="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-500 disabled:opacity-50 transition"
          >
            {{
              invoiceLoading ? 'Signing 60s URL...' : '📄 Download Receipt (PDF)'
            }}
          </button>
        </div>
        <p v-if="invoiceError" class="text-xs font-medium text-rose-400">
          {{ invoiceError }}
        </p>
      </div>

      <!-- Stripe Checkout Redirect Card (shown when STRIPE_SECRET_KEY Test Mode is enabled) -->
      <div
        v-if="order.status === 'PENDING' && payment?.checkoutUrl"
        class="rounded-xl border border-indigo-500/40 bg-indigo-950/30 p-5 space-y-3"
      >
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 class="text-sm font-bold text-indigo-200">
              Complete Payment on Stripe Checkout (Test Mode)
            </h3>
            <p class="mt-1 text-xs text-slate-300">
              Test cards: <code class="text-emerald-300">4242 4242 4242 4242</code>
              (success) or <code class="text-rose-300">4000 0000 0000 0002</code>
              (decline → Saga stock rollback).
            </p>
          </div>
          <a
            :href="payment.checkoutUrl"
            data-testid="stripe-checkout-link"
            class="shrink-0 inline-flex items-center justify-center rounded-xl bg-indigo-600 px-5 py-2.5 text-xs font-bold text-white shadow-lg shadow-indigo-600/30 hover:bg-indigo-500 transition"
          >
            Pay with Stripe →
          </a>
        </div>
      </div>

      <!-- Refund Saga Controls (Visible for PAID, REFUNDING, REFUNDED) -->
      <div
        v-if="order.status === 'PAID'"
        class="rounded-xl border border-violet-500/30 bg-violet-950/20 p-5 space-y-3"
      >
        <div class="flex flex-col gap-1">
          <h3 class="text-sm font-bold text-violet-200">
            Request Refund (Choreography Refund Saga)
          </h3>
          <p class="text-xs text-slate-400">
            Triggers <code class="text-violet-300">order.refund_requested</code>
            → idempotent payment refund → stock restoration +
            <code class="text-violet-300">StockMovement</code> audit → Mailpit
            receipt &amp; WebSocket update.
          </p>
        </div>

        <div class="flex flex-col gap-3 sm:flex-row">
          <input
            v-model="refundReason"
            type="text"
            placeholder="Optional refund reason (e.g. Changed my mind)"
            class="flex-1 rounded-xl border border-slate-700 bg-slate-900 px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:border-violet-500 focus:outline-none"
          />
          <button
            data-testid="request-refund-btn"
            :disabled="refundLoading"
            @click="handleRequestRefund"
            class="rounded-xl bg-violet-600 px-5 py-2 text-sm font-bold text-white hover:bg-violet-500 disabled:opacity-50 transition"
          >
            {{ refundLoading ? 'Requesting Refund...' : 'Request Refund' }}
          </button>
        </div>

        <p v-if="refundError" class="text-xs font-medium text-rose-400">
          {{ refundError }}
        </p>
      </div>

      <div
        v-else-if="order.status === 'REFUNDED' && payment?.refundTransactionId"
        class="rounded-xl border border-violet-500/40 bg-violet-950/30 p-4 text-xs text-violet-200 flex flex-wrap items-center justify-between gap-2"
      >
        <span>
          Refund completed &amp; inventory restocked via Refund Saga.
        </span>
        <span class="font-mono font-bold text-violet-300">
          Refund Tx: {{ payment.refundTransactionId }}
        </span>
      </div>
    </div>
  </div>
</template>
