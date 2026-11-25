<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.store';
import { useCartStore } from '../stores/cart.store';
import { useToastStore } from '../stores/toast.store';

const authStore = useAuthStore();
const cartStore = useCartStore();
const toastStore = useToastStore();
const router = useRouter();
const route = useRoute();

const email = ref('');
const password = ref('');
const totpCode = ref('');
const requires2fa = ref(false);
const errorMsg = ref('');

onMounted(async () => {
  if (route.query.oauth === 'success') {
    try {
      await authStore.refreshToken();
      await cartStore.fetchCart();
      toastStore.show(
        'Signed in with Google',
        'Google OAuth 2.0 session established.',
        'success',
      );
      router.replace('/');
    } catch {
      errorMsg.value = 'Could not complete Google OAuth session';
    }
  } else if (route.query.oauth_error) {
    const err = String(route.query.oauth_error);
    errorMsg.value =
      err === 'google_not_configured'
        ? 'Google OAuth is not configured yet (set GOOGLE_CLIENT_ID & GOOGLE_CLIENT_SECRET in .env).'
        : `Google OAuth sign-in failed (${err}).`;
  }
});

async function handleLogin() {
  errorMsg.value = '';
  try {
    await authStore.login(
      email.value,
      password.value,
      requires2fa.value ? totpCode.value.trim() : undefined,
    );
    await cartStore.fetchCart();
    router.push('/');
  } catch (err: any) {
    const msg = err?.response?.data?.message || 'Invalid email or password';
    if (msg === '2FA_REQUIRED') {
      requires2fa.value = true;
      errorMsg.value =
        'Two-Factor Authentication is enabled — enter your 6-digit Google Authenticator code.';
      return;
    }
    errorMsg.value = msg;
  }
}
</script>

<template>
  <div class="mx-auto max-w-md pt-8">
    <div
      class="rounded-2xl border border-slate-800 bg-slate-900/80 p-8 shadow-xl space-y-6"
    >
      <div>
        <h1 class="text-2xl font-extrabold text-white">Sign In</h1>
        <p class="mt-1 text-xs text-slate-400">
          Access your Redis cart, orders, active sessions, and real-time
          notifications.
        </p>
      </div>

      <!-- Google OAuth 2.0 Button -->
      <a
        href="/api/auth/google"
        data-testid="google-oauth-btn"
        class="flex w-full items-center justify-center gap-2.5 rounded-xl border border-slate-700 bg-slate-950 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 transition"
      >
        <span class="text-base font-black text-indigo-400">G</span>
        <span>Continue with Google (OAuth 2.0)</span>
      </a>

      <div class="relative flex items-center">
        <div class="flex-grow border-t border-slate-800"></div>
        <span class="mx-3 text-[11px] uppercase tracking-wider text-slate-500"
          >or with email</span
        >
        <div class="flex-grow border-t border-slate-800"></div>
      </div>

      <form @submit.prevent="handleLogin" class="space-y-4">
        <div>
          <label class="block text-xs font-medium text-slate-300 mb-1"
            >Email</label
          >
          <input
            v-model="email"
            type="email"
            required
            placeholder="you@example.com"
            data-testid="login-email-input"
            class="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-2.5 text-sm text-white focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <div>
          <label class="block text-xs font-medium text-slate-300 mb-1"
            >Password</label
          >
          <input
            v-model="password"
            type="password"
            required
            placeholder="••••••••"
            data-testid="login-password-input"
            class="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-2.5 text-sm text-white focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <div v-if="requires2fa">
          <label class="block text-xs font-bold text-amber-300 mb-1"
            >2FA Code (Google Authenticator)</label
          >
          <input
            v-model="totpCode"
            type="text"
            inputmode="numeric"
            maxlength="6"
            required
            placeholder="123456"
            data-testid="login-2fa-input"
            class="w-full rounded-xl border border-amber-500/50 bg-slate-950 px-4 py-2.5 text-center font-mono text-lg tracking-[0.4em] text-white focus:border-amber-400 focus:outline-none"
          />
        </div>

        <p v-if="errorMsg" class="text-xs text-rose-400">{{ errorMsg }}</p>

        <button
          type="submit"
          :disabled="authStore.loading"
          data-testid="login-submit-btn"
          class="w-full rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {{
            authStore.loading
              ? 'Signing in...'
              : requires2fa
                ? 'Verify 2FA & Sign In'
                : 'Sign In'
          }}
        </button>
      </form>

      <div class="text-center text-xs text-slate-400">
        Don't have an account?
        <router-link
          to="/register"
          class="font-semibold text-indigo-400 hover:text-indigo-300"
        >
          Create an account
        </router-link>
      </div>
    </div>
  </div>
</template>
