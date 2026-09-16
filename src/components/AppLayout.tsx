import { NavLink, Outlet } from 'react-router-dom'
import { demoRoutes } from '@/router/routes'
import './AppLayout.css'

export default function AppLayout() {
  return (
    <div className="app-layout">
      <aside className="sidebar">
        <h2 className="sidebar-title">Mapbox GL Demos</h2>
        <nav className="nav-menu">
          {demoRoutes.map((route) => (
            <NavLink
              key={route.path}
              to={route.path}
              className={({ isActive }) =>
                `nav-item${isActive ? ' active' : ''}`
              }
            >
              {route.title}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  )
}
