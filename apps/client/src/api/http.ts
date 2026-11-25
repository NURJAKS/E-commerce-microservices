import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';

let accessTokenGetter: () => string | null = () => null;
let refreshTokenHandler: () => Promise<string | null> = async () => null;
let unauthorizedLogoutHandler: () => void = () => {};

export function configureHttpAuthCallbacks(callbacks: {
  getAccessToken: () => string | null;
  onRefreshToken: () => Promise<string | null>;
  onUnauthorizedLogout: () => void;
}) {
  accessTokenGetter = callbacks.getAccessToken;
  refreshTokenHandler = callbacks.onRefreshToken;
  unauthorizedLogoutHandler = callbacks.onUnauthorizedLogout;
}

export const http = axios.create({
  baseURL: '/api',
  timeout: 15000,
  withCredentials: true,
});

function getOrCreateViewerId(): string {
  if (typeof window === 'undefined') return '';
  const storageKey = 'novashop_viewer_id';
  let id = window.localStorage.getItem(storageKey);
  if (!id) {
    id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `viewer-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(storageKey, id);
  }
  return id;
}

// Request Interceptor: automatically attach Bearer token & anonymous X-Viewer-Id
http.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = accessTokenGetter();
  if (config.headers) {
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    const viewerId = getOrCreateViewerId();
    if (viewerId) {
      config.headers['X-Viewer-Id'] = viewerId;
    }
  }
  return config;
});

let isRefreshing = false;
let failedQueue: Array<{
  resolve: (token: string) => void;
  reject: (err: unknown) => void;
}> = [];

function processQueue(error: unknown, token: string | null = null) {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.reject(error);
    } else if (token) {
      prom.resolve(token);
    }
  });
  failedQueue = [];
}

// Response Interceptor: handle 401, queue requests, rotate Refresh Token via /api/auth/refresh
http.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & {
      _retry?: boolean;
    };

    const url = originalRequest?.url || '';
    const isAuthEndpoint =
      url.includes('/auth/login') ||
      url.includes('/auth/register') ||
      url.includes('/auth/refresh');

    if (
      error.response?.status === 401 &&
      originalRequest &&
      !originalRequest._retry &&
      !isAuthEndpoint
    ) {
      if (isRefreshing) {
        return new Promise<string>((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then((newToken) => {
          originalRequest.headers.Authorization = `Bearer ${newToken}`;
          return http(originalRequest);
        });
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        const newAccessToken = await refreshTokenHandler();
        if (!newAccessToken) {
          throw new Error('Refresh token failed');
        }
        processQueue(null, newAccessToken);
        originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
        return http(originalRequest);
      } catch (refreshError) {
        processQueue(refreshError, null);
        unauthorizedLogoutHandler();
        if (
          typeof window !== 'undefined' &&
          !window.location.pathname.startsWith('/login')
        ) {
          window.location.href = '/login';
        }
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  },
);
