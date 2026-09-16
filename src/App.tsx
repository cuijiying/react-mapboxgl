import { Suspense } from 'react'
import AppRouter from '@/router'

function App() {
  return (
    <Suspense
      fallback={
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: '#666',
          }}
        >
          加载中...
        </div>
      }
    >
      <AppRouter />
    </Suspense>
  )
}

export default App
