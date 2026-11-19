import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 只对"可重试"的后端错误重试；契约错误不重试。
      retry: (count, err) => (err instanceof ApiError ? err.retryable && count < 2 : count < 2),
      refetchOnWindowFocus: true,
      // 窗口不可见时暂停轮询（对齐 00 设计基线 §8）。
      refetchIntervalInBackground: false,
      staleTime: 0,
    },
    mutations: { retry: 0 },
  },
});
