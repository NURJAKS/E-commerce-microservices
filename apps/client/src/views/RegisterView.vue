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

async function handleRegister() {
  errorMsg.value = '';
  try {
    await authStore.register(email.value, password.value);
    await cartStore.fetchCart();
    router.push('/');
  } catch (err: any) {
    errorMsg.value =
      err?.response?.data?.message || 'Registration failed';
  }
}
</script>

<template>
  <div class="mx-auto max-w-md pt-8">
    <div
      class="rounded-2xl border border-slate-800 bg-slate-900/80 p-8 shadow-xl space-y-6"
    >
      <div>
        <h1 class="text-2xl font-extrabold text-white">Create Account</h1>
        <p class="mt-1 text-xs text-slate-400">
          Registers via Auth Service, issues 15m JWT + 7d Refresh Token, and
          sends a welcome email to Mailpit.
        </p>
      </div>

      <form @submit.prevent="handleRegister" class="space-y-4">
        <div>
          <label class="block text-xs font-medium text-slate-300 mb-1"
            >Email Address</label
          >
          <input
            v-model="email"
            type="email"
            required
            placeholder="customer@example.com"
            data-testid="register-email-input"
            class="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-2.5 text-sm text-white focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <div>
          <label class="block text-xs font-medium text-slate-300 mb-1"
            >Password (min 6 chars)</label
          >
          <input
            v-model="password"
            type="password"
            required
            minlength="6"
            placeholder="StrongPass123!"
            data-testid="register-password-input"
            class="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-2.5 text-sm text-white focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <p v-if="errorMsg" class="text-xs text-rose-400">{{ errorMsg }}</p>

        <button
          type="submit"
          :disabled="authStore.loading"
          data-testid="register-submit-btn"
          class="w-full rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {{ authStore.loading ? 'Creating Account...' : 'Create Account' }}
        </button>
      </form>

      <div class="text-center text-xs text-slate-400">
        Already registered?
        <router-link
          to="/login"
          class="font-semibold text-indigo-400 hover:text-indigo-300"
        >
          Sign In
        </router-link>
      </div>
    </div>
  </div>
</template>
