<script setup lang="ts">
import { useToastStore } from '../stores/toast.store';

const toastStore = useToastStore();
</script>

<template>
  <div
    class="fixed bottom-5 right-5 z-50 flex flex-col gap-2.5 max-w-sm w-full pointer-events-none"
    data-testid="toast-container"
  >
    <div
      v-for="toast in toastStore.toasts"
      :key="toast.id"
      class="pointer-events-auto flex items-start justify-between gap-3 rounded-xl border p-4 shadow-xl backdrop-blur-md transition-all"
      :class="{
        'border-emerald-500/40 bg-emerald-950/90 text-emerald-100':
          toast.type === 'success',
        'border-indigo-500/40 bg-indigo-950/90 text-indigo-100':
          toast.type === 'info',
        'border-amber-500/40 bg-amber-950/90 text-amber-100':
          toast.type === 'warning',
        'border-rose-500/40 bg-rose-950/90 text-rose-100':
          toast.type === 'error',
      }"
    >
      <div>
        <h4 class="text-sm font-bold">{{ toast.title }}</h4>
        <p class="mt-0.5 text-xs opacity-90">{{ toast.message }}</p>
      </div>
      <button
        @click="toastStore.dismiss(toast.id)"
        class="text-xs opacity-70 hover:opacity-100"
      >
        ✕
      </button>
    </div>
  </div>
</template>
