<script setup lang="ts">
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from './stores/auth.store';
import { useCartStore } from './stores/cart.store';
import CartDrawer from './components/CartDrawer.vue';
import ToastContainer from './components/ToastContainer.vue';

const authStore = useAuthStore();
const cartStore = useCartStore();
const router = useRouter();

onMounted(async () => {
  await authStore.restoreSessionIfAvailable();
  if (authStore.isAuthenticated) {
    await cartStore.fetchCart();
  }
});

async function handleLogout() {
  await authStore.logout();
  cartStore.items = [];
  router.push('/');
}
</script>

<template>
  <div class="min-h-screen flex flex-col bg-slate-950 text-slate-100">
    <!-- Top Navigation Bar -->
    <header
      class="sticky top-0 z-40 border-b border-slate-800/80 bg-slate-950/85 backdrop-blur-md"
    >
      <div
        class="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8"
      >
        <div class="flex items-center gap-6">
          <router-link
            to="/"
            class="flex items-center gap-2 text-lg font-black tracking-tight text-white"
          >
            <span
              class="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-sm font-black text-white"
              >N</span
            >
            <span>NovaShop</span>
          </router-link>

          <nav class="hidden sm:flex items-center gap-4 text-xs font-semibold text-slate-300">
            <router-link to="/" class="hover:text-white transition"
              >Catalog</router-link
            >
            <router-link
              v-if="authStore.isAdmin"
              to="/admin"
              class="text-indigo-400 hover:text-indigo-300 transition"
            >
              Admin &amp; MinIO Upload
            </router-link>
          </nav>
        </div>

        <div class="flex items-center gap-3">
          <button
            @click="cartStore.isOpen = true"
            data-testid="open-cart-btn"
            class="relative inline-flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:border-indigo-500/50 transition"
          >
            <span>🛒 Cart</span>
            <span
              data-testid="cart-badge-count"
              class="rounded-full bg-indigo-600 px-2 py-0.5 text-[11px] font-bold text-white"
            >
              {{ cartStore.itemCount }}
            </span>
          </button>

          <template v-if="authStore.isAuthenticated">
            <span
              class="hidden md:inline-block text-xs text-slate-400"
              data-testid="nav-user-email"
            >
              {{ authStore.user?.email }}
            </span>
            <button
              @click="handleLogout"
              data-testid="logout-btn"
              class="rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-800"
            >
              Logout
            </button>
          </template>
          <template v-else>
            <router-link
              to="/login"
              data-testid="nav-login-link"
              class="rounded-xl border border-slate-800 bg-slate-900 px-3.5 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-800"
            >
              Sign In
            </router-link>
            <router-link
              to="/register"
              data-testid="nav-register-link"
              class="rounded-xl bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
            >
              Register
            </router-link>
          </template>
        </div>
      </div>
    </header>

    <!-- Main Content -->
    <main class="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
      <router-view />
    </main>

    <!-- Slide-Over Cart Drawer & Real-Time Toast Notifications -->
    <CartDrawer />
    <ToastContainer />
  </div>
</template>
