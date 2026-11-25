import { io, Socket } from 'socket.io-client';
import { ref } from 'vue';
import type {
  OrderStatusUpdatedWsPayload,
  ProductRestockedWsPayload,
} from '@shop/contracts';
import { useToastStore } from '../stores/toast.store';

export interface SagaCheckoutInitiatedPayload {
  idempotencyKey: string;
  discountCode?: string;
  subtotal: number;
  itemCount: number;
  timestamp: string;
}

class SocketManager {
  private socket: Socket | null = null;
  private broadcastChannel: BroadcastChannel | null = null;
  public readonly connected = ref(false);
  public readonly latestOrderEvent = ref<OrderStatusUpdatedWsPayload | null>(
    null,
  );
  private listeners = new Set<
    (payload: OrderStatusUpdatedWsPayload) => void
  >();
  private checkoutStartListeners = new Set<
    (payload: SagaCheckoutInitiatedPayload) => void
  >();

  constructor() {
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      this.broadcastChannel = new BroadcastChannel('novashop_saga_telemetry');
      this.broadcastChannel.onmessage = (event) => {
        if (event.data?.type === 'CHECKOUT_INITIATED') {
          for (const listener of this.checkoutStartListeners) {
            listener(event.data.payload as SagaCheckoutInitiatedPayload);
          }
        }
      };
    }
  }

  connect(accessToken?: string) {
    if (this.socket) {
      this.disconnect();
    }

    this.socket = io('/', {
      path: '/socket.io',
      auth: accessToken ? { token: accessToken } : {},
      transports: ['websocket', 'polling'],
    });

    this.socket.on('connect', () => {
      this.connected.value = true;
    });

    this.socket.on('disconnect', () => {
      this.connected.value = false;
    });

    this.socket.on(
      'notification:order_status_updated',
      (payload: OrderStatusUpdatedWsPayload) => {
        this.latestOrderEvent.value = payload;

        const toastStore = useToastStore();
        if (payload.status === 'PAID') {
          toastStore.show('Order Paid!', payload.message, 'success');
        } else if (payload.status === 'REFUNDED') {
          toastStore.show('Order Refunded', payload.message, 'success');
        } else if (payload.status === 'REFUNDING') {
          toastStore.show('Refund Processing', payload.message, 'info');
        } else if (
          payload.status === 'FAILED' ||
          payload.status === 'CANCELLED'
        ) {
          toastStore.show('Order Update', payload.message, 'error');
        } else {
          toastStore.show('Order Processing', payload.message, 'info');
        }

        for (const listener of this.listeners) {
          listener(payload);
        }
      },
    );

    this.socket.on(
      'notification:product_restocked',
      (payload: ProductRestockedWsPayload) => {
        const toastStore = useToastStore();
        toastStore.show('Back in Stock!', payload.message, 'success');
      },
    );
  }

  onOrderStatusUpdated(
    callback: (payload: OrderStatusUpdatedWsPayload) => void,
  ): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  onCheckoutInitiated(
    callback: (payload: SagaCheckoutInitiatedPayload) => void,
  ): () => void {
    this.checkoutStartListeners.add(callback);
    return () => {
      this.checkoutStartListeners.delete(callback);
    };
  }

  notifyCheckoutInitiated(payload: SagaCheckoutInitiatedPayload): void {
    for (const listener of this.checkoutStartListeners) {
      listener(payload);
    }
    this.broadcastChannel?.postMessage({
      type: 'CHECKOUT_INITIATED',
      payload,
    });
  }

  ensureConnected(): void {
    if (!this.socket) {
      this.connect();
    }
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.connected.value = false;
    }
  }
}

export const socketManager = new SocketManager();
