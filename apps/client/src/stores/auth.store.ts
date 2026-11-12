import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { AuthTokensResponse, UserDto } from '@shop/contracts';
import { configureHttpAuthCallbacks, http } from '../api/http';
import { socketManager } from '../services/socket';

const USER_STORAGE_KEY = 'shop_user_profile';

export const useAuthStore = defineStore('auth', () => {
  const user = ref<UserDto | null>(null);
  // Access token is kept strictly in memory (Pinia); Refresh token lives in an HttpOnly SameSite=Strict cookie
  const accessToken = ref<string | null>(null);
  const loading = ref(false);

  if (typeof localStorage !== 'undefined') {
    const cachedUser = localStorage.getItem(USER_STORAGE_KEY);
    if (cachedUser) {
      try {
        user.value = JSON.parse(cachedUser);
      } catch {
        // Ignore parse error
      }
    }
  }

  const isAuthenticated = computed(() =>
    Boolean(accessToken.value && user.value),
  );
  const isAdmin = computed(() => user.value?.role === 'ADMIN');

  function setAuthSession(data: AuthTokensResponse) {
    user.value = data.user;
    accessToken.value = data.accessToken;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(data.user));
    }
    socketManager.connect(data.accessToken);
  }

  function clearSession() {
    user.value = null;
    accessToken.value = null;
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(USER_STORAGE_KEY);
    }
    socketManager.disconnect();
  }

  async function register(email: string, password: string) {
    loading.value = true;
    try {
      const { data } = await http.post<AuthTokensResponse>('/auth/register', {
        email,
        password,
      });
      setAuthSession(data);
      return data;
    } finally {
      loading.value = false;
    }
  }

  async function login(email: string, password: string) {
    loading.value = true;
    try {
      const { data } = await http.post<AuthTokensResponse>('/auth/login', {
        email,
        password,
      });
      setAuthSession(data);
      return data;
    } finally {
      loading.value = false;
    }
  }

  async function refreshToken(): Promise<string | null> {
    // HttpOnly cookie `refresh_token` is automatically sent via withCredentials: true
    const { data } = await http.post<AuthTokensResponse>('/auth/refresh', {});
    setAuthSession(data);
    return data.accessToken;
  }

  async function logout() {
    try {
      await http.post('/auth/logout', {});
    } catch {
      // Ignore network errors during logout
    } finally {
      clearSession();
    }
  }

  async function restoreSessionIfAvailable() {
    if (user.value && !accessToken.value) {
      try {
        await refreshToken();
      } catch {
        clearSession();
      }
    }
  }

  configureHttpAuthCallbacks({
    getAccessToken: () => accessToken.value,
    onRefreshToken: () => refreshToken(),
    onUnauthorizedLogout: () => clearSession(),
  });

  return {
    user,
    accessToken,
    loading,
    isAuthenticated,
    isAdmin,
    register,
    login,
    refreshToken,
    logout,
    restoreSessionIfAvailable,
  };
});
