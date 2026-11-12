<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.store';
import { useCartStore } from '../stores/cart.store';

const authStore = useAuthStore();
const cartStore = useCartStore();
const router = useRouter();

const email = ref('');
const password = ref('');
const errorMsg = ref('');

async function handleLogin() {
  errorMsg.value = '';
  try {
    await authStore.login(email.value, password.value);
    await cartStore.fetchCart();
    router.push('/');
  } catch (err: any) {
    errorMsg.value =
      err?.response?.data?.message || 'Invalid email or password';
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
          Access your Redis cart, orders, and real-time WebSocket notifications.
        </p>
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

        <p v-if="errorMsg" class="text-xs text-rose-400">{{ errorMsg }}</p>

        <button
          type="submit"
          :disabled="authStore.loading"
          data-testid="login-submit-btn"
          class="w-full rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {{ authStore.loading ? 'Signing in...' : 'Sign In' }}
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
