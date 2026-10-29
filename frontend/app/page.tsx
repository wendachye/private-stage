'use client';

import dynamic from 'next/dynamic';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '@/client/api';

const StageApp = dynamic(() => import('@/client/App'), { ssr: false, loading: () => <main className="loading-screen"><span className="brand-name">Private Stage.</span><div className="loading-line" /></main> });

export default function Page() {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: {
    queries: { retry: (count, error) => !(error instanceof ApiError && (error.status === 401 || error.status === 403 || !!error.retryAfterSeconds)) && count < 2, staleTime: 5000, refetchOnWindowFocus: true },
    mutations: { retry: false },
  } }));
  return <QueryClientProvider client={queryClient}><StageApp /></QueryClientProvider>;
}
