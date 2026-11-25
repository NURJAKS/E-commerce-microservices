<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { SessionDto, TotpSetupResponse } from '@shop/contracts';
import { useAuthStore } from '../stores/auth.store';
import { useToastStore } from '../stores/toast.store';

const authStore = useAuthStore();
const toastStore = useToastStore();
const router = useRouter();

const sessions = ref<SessionDto[]>([]);
const loadingSessions = ref(true);

const totpSetup = ref<TotpSetupResponse | null>(null);
const totpCode = ref('');
const disableCode = ref('');
const totpBusy = ref(false);

async function loadSessions() {
  loadingSessions.value = true;
  try {
    await authStore.fetchMe();
    sessions.value = await authStore.fetchSessions();
  } catch {
    router.push('/login');
  } finally {
    loadingSessions.value = false;
  }
}

onMounted(async () => {
  if (!authStore.isAuthenticated) {
    router.push('/login');
    return;
  }
  await loadSessions();
});

async function handleRevokeSession(sessionId: string) {
  try {
    await authStore.revokeSession(sessionId);
    toastStore.show(
      'Session Terminated',
      'Refresh token family revoked and active JWT blacklisted in Redis.',
      'success',
    );
    await loadSessions();
  } catch (err: any) {
    toastStore.show(
      'Revoke Failed',
      err?.response?.data?.message || 'Could not terminate session',
      'error',
    );
  }
}

async function handleRevokeAll() {
  try {
    await authStore.revokeAllSessions();
    toastStore.show(
      'Logged Out Everywhere',
      'All device sessions revoked and active JWT tokens blacklisted in Redis.',
      'info',
    );
    router.push('/login');
  } catch (err: any) {
    toastStore.show(
      'Error',
      err?.response?.data?.message || 'Could not revoke all sessions',
      'error',
    );
  }
}

async function handleStart2faSetup() {
  totpBusy.value = true;
  try {
    totpSetup.value = await authStore.setupTwoFactor();
  } catch (err: any) {
    toastStore.show(
      '2FA Setup Error',
      err?.response?.data?.message || 'Failed to initialize 2FA',
      'error',
    );
  } finally {
    totpBusy.value = false;
  }
}

async function handleEnable2fa() {
  totpBusy.value = true;
  try {
    await authStore.enableTwoFactor(totpCode.value.trim());
    totpSetup.value = null;
    totpCode.value = '';
    toastStore.show(
      '2FA Enabled',
      'Google Authenticator TOTP protection is now active on your account.',
      'success',
    );
  } catch (err: any) {
    toastStore.show(
      'Invalid Code',
      err?.response?.data?.message || 'Invalid 6-digit authenticator code',
      'error',
    );
  } finally {
    totpBusy.value = false;
  }
}

async function handleDisable2fa() {
  totpBusy.value = true;
  try {
    await authStore.disableTwoFactor(disableCode.value.trim());
    disableCode.value = '';
    toastStore.show(
      '2FA Disabled',
      'Two-factor authentication has been turned off.',
      'info',
    );
  } catch (err: any) {
    toastStore.show(
      'Verification Failed',
      err?.response?.data?.message || 'Invalid 6-digit authenticator code',
      'error',
    );
  } finally {
    totpBusy.value = false;
  }
}
</script>

<template>
  <div class="max-w-4xl mx-auto space-y-6">
    <!-- Header -->
    <section
      class="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div>
        <h1 class="text-2xl font-extrabold text-white">
          Account Security &amp; Active Sessions
        </h1>
        <p class="mt-1 text-xs text-slate-400">
          Protected by Refresh Token Rotation with
          <code class="text-indigo-300">familyId</code> Reuse Detection,
          instant Redis JWT Blacklisting, and RFC 6238 TOTP 2FA.
        </p>
      </div>
      <div class="text-xs text-right text-slate-300">
        <div class="font-bold text-white">{{ authStore.user?.email }}</div>
        <div class="text-[11px] text-indigo-400">
          Role: {{ authStore.user?.role }} · Provider:
          {{ authStore.user?.authProvider || 'LOCAL' }}
        </div>
      </div>
    </section>

    <!-- Active Sessions Panel -->
    <section
      class="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 space-y-4"
    >
      <div
        class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-slate-800 pb-4"
      >
        <div>
          <h2 class="text-lg font-bold text-white">
            Active Device Sessions ({{ sessions.length }})
          </h2>
          <p class="text-xs text-slate-400">
            Replaying a rotated refresh token automatically revokes the entire
            session family and blacklists active access tokens in Redis.
          </p>
        </div>

        <button
          @click="handleRevokeAll"
          data-testid="revoke-all-sessions-btn"
          class="rounded-xl border border-rose-500/40 bg-rose-500/15 px-4 py-2 text-xs font-bold text-rose-300 hover:bg-rose-500/25 transition"
        >
          Log Out All Devices
        </button>
      </div>

      <div v-if="loadingSessions" class="py-6 text-center text-xs text-slate-400">
        Loading active sessions...
      </div>

      <div v-else-if="sessions.length === 0" class="py-6 text-center text-xs text-slate-400">
        No active sessions found.
      </div>

      <div v-else class="space-y-3">
        <div
          v-for="s in sessions"
          :key="s.id"
          class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-xl border border-slate-800 bg-slate-950/70 p-4"
        >
          <div class="space-y-1">
            <div class="flex items-center gap-2">
              <span class="text-sm font-bold text-white">{{
                s.deviceName
              }}</span>
              <span
                v-if="s.isCurrent"
                class="rounded-full bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-bold text-emerald-300"
              >
                Current Device
              </span>
            </div>
            <p class="text-xs text-slate-400 font-mono">
              IP: {{ s.ipAddress || 'unknown' }} · Family:
              {{ s.familyId.slice(0, 8) }}
            </p>
            <p class="text-[11px] text-slate-500">
              Signed in {{ new Date(s.createdAt).toLocaleString() }} · Last
              rotated {{ new Date(s.lastUsedAt).toLocaleString() }}
            </p>
          </div>

          <button
            @click="handleRevokeSession(s.id)"
            class="rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-1.5 text-xs font-semibold text-rose-300 hover:bg-rose-900/40 transition"
          >
            Terminate Session
          </button>
        </div>
      </div>
    </section>

    <!-- 2FA (TOTP / Google Authenticator) Panel -->
    <section
      class="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 space-y-4"
    >
      <div class="flex items-center justify-between border-b border-slate-800 pb-4">
        <div>
          <div class="flex items-center gap-2">
            <h2 class="text-lg font-bold text-white">
              Two-Factor Authentication (TOTP / Google Authenticator)
            </h2>
            <span
              v-if="authStore.isAdmin"
              class="rounded bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 text-[10px] font-bold text-amber-300"
            >
              Recommended for ADMIN
            </span>
          </div>
          <p class="mt-1 text-xs text-slate-400">
            Protect your account with 6-digit RFC 6238 one-time passwords from
            Google Authenticator or Authy.
          </p>
        </div>

        <span
          class="rounded-xl px-3 py-1.5 text-xs font-bold border"
          :class="
            authStore.user?.totpEnabled
              ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
              : 'border-slate-700 bg-slate-950 text-slate-400'
          "
        >
          {{ authStore.user?.totpEnabled ? '2FA ENABLED' : '2FA OFF' }}
        </span>
      </div>

      <!-- Already enabled: Disable flow -->
      <div v-if="authStore.user?.totpEnabled" class="space-y-3">
        <p class="text-xs text-slate-300">
          2FA is active. Enter a current 6-digit authenticator code if you wish
          to disable it:
        </p>
        <form @submit.prevent="handleDisable2fa" class="flex flex-wrap gap-2">
          <input
            v-model="disableCode"
            type="text"
            inputmode="numeric"
            maxlength="6"
            required
            placeholder="6-digit code"
            class="w-40 rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2 text-center font-mono text-sm tracking-widest text-white"
          />
          <button
            type="submit"
            :disabled="totpBusy"
            class="rounded-xl border border-rose-500/40 bg-rose-500/15 px-4 py-2 text-xs font-bold text-rose-300 hover:bg-rose-500/25 disabled:opacity-50"
          >
            Disable 2FA
          </button>
        </form>
      </div>

      <!-- Setup in progress: QR Code + Confirm -->
      <div
        v-else-if="totpSetup"
        class="grid grid-cols-1 gap-6 sm:grid-cols-2 items-center rounded-xl border border-indigo-500/30 bg-indigo-950/20 p-5"
      >
        <div class="flex flex-col items-center gap-3">
          <img
            :src="totpSetup.qrCodeDataUrl"
            alt="Google Authenticator QR Code"
            class="h-44 w-44 rounded-xl bg-white p-2"
          />
          <div class="text-center">
            <span class="block text-[11px] text-slate-400"
              >Manual Base32 Secret:</span
            >
            <code class="text-xs font-mono font-bold text-indigo-300 select-all">
              {{ totpSetup.secret }}
            </code>
          </div>
        </div>

        <form @submit.prevent="handleEnable2fa" class="space-y-3">
          <p class="text-xs text-slate-300 leading-relaxed">
            1. Scan the QR code with <strong>Google Authenticator</strong>.<br />
            2. Enter the 6-digit code shown in the app to activate 2FA:
          </p>
          <input
            v-model="totpCode"
            type="text"
            inputmode="numeric"
            maxlength="6"
            required
            placeholder="123456"
            class="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-2.5 text-center font-mono text-lg tracking-[0.4em] text-white"
          />
          <button
            type="submit"
            :disabled="totpBusy"
            class="w-full rounded-xl bg-emerald-600 py-2.5 text-xs font-bold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            Verify &amp; Activate 2FA
          </button>
        </form>
      </div>

      <!-- Not enabled yet: Start setup -->
      <div v-else>
        <button
          @click="handleStart2faSetup"
          :disabled="totpBusy"
          data-testid="setup-2fa-btn"
          class="rounded-xl bg-indigo-600 px-5 py-2.5 text-xs font-bold text-white hover:bg-indigo-500 disabled:opacity-50 transition"
        >
          Enable Google Authenticator (2FA)
        </button>
      </div>
    </section>
  </div>
</template>
