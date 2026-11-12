import { defineStore } from 'pinia';
import { ref } from 'vue';

export interface ToastNotification {
  id: string;
  title: string;
  message: string;
  type: 'success' | 'info' | 'warning' | 'error';
}

export const useToastStore = defineStore('toast', () => {
  const toasts = ref<ToastNotification[]>([]);

  function show(
    title: string,
    message: string,
    type: ToastNotification['type'] = 'info',
    durationMs = 5000,
  ) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    toasts.value.push({ id, title, message, type });
    setTimeout(() => {
      dismiss(id);
    }, durationMs);
  }

  function dismiss(id: string) {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }

  return {
    toasts,
    show,
    dismiss,
  };
});
