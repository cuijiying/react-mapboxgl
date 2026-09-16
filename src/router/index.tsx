import { Navigate, Route, Routes } from 'react-router-dom'
import AppLayout from '@/components/AppLayout'
import { demoRoutes } from './routes'

export default function AppRouter() {
  return (
    <Routes>
      <Route path="/" element={<AppLayout />}>
        <Route index element={<Navigate to="/geojson-demo" replace />} />
        {demoRoutes.map(({ path, Component }) => (
          <Route key={path} path={path.slice(1)} element={<Component />} />
        ))}
      </Route>
    </Routes>
  )
}
