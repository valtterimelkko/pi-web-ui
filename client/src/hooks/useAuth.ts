import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AuthState {
  isAuthenticated: boolean;
  csrfToken: string | null;
  login: (password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  setCsrfToken: (token: string) => void;
}

const API_BASE = '/api';

export const useAuth = create<AuthState>()(
  persist(
    (set, _get) => ({
      isAuthenticated: false,
      csrfToken: null,

      login: async (password: string) => {
        try {
          const response = await fetch(`${API_BASE}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password }),
            credentials: 'include',
          });

          const data = await response.json();

          if (!response.ok) {
            return { success: false, error: data.error || 'Login failed' };
          }

          set({
            isAuthenticated: true,
            csrfToken: data.csrfToken,
          });

          return { success: true };
        } catch (_error) {
          return { success: false, error: 'Network error' };
        }
      },

      logout: async () => {
        try {
          await fetch(`${API_BASE}/auth/logout`, {
            method: 'POST',
            credentials: 'include',
          });
        } catch (error) {
          console.error('Logout error:', error);
        } finally {
          set({ isAuthenticated: false, csrfToken: null });
        }
      },

      setCsrfToken: (token: string) => {
        set({ csrfToken: token });
      },
    }),
    {
      name: 'pi-web-ui-auth',
      partialize: (state) => ({ csrfToken: state.csrfToken }),
    }
  )
);

export async function checkAuthStatus(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/auth/me`, {
      credentials: 'include',
    });
    if (response.ok) {
      useAuth.setState({ isAuthenticated: true });
      return true;
    }
    useAuth.setState({ isAuthenticated: false });
    return false;
  } catch {
    useAuth.setState({ isAuthenticated: false });
    return false;
  }
}
