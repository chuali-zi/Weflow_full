import { useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAppStore } from '../stores/appStore'

interface RouteGuardProps {
  children: React.ReactNode
}

const PUBLIC_ROUTES = ['/', '/home', '/settings', '/account-management']

function RouteGuard({ children }: RouteGuardProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const isDbConnected = useAppStore(state => state.isDbConnected)
  const isDbInitializing = useAppStore(state => state.isDbInitializing)
  const isPublicRoute = PUBLIC_ROUTES.includes(location.pathname)

  useEffect(() => {
    // Startup connection is asynchronous; preserve the requested route until
    // its result is known instead of treating the initial false as a failure.
    if (!isDbInitializing && !isDbConnected && !isPublicRoute) {
      navigate('/', { replace: true })
    }
  }, [isDbInitializing, isDbConnected, isPublicRoute, navigate])

  if (isDbInitializing && !isDbConnected && !isPublicRoute) {
    return <div className="route-loading" role="status" aria-live="polite"><span /><small>正在连接聊天记录…</small></div>
  }

  return <>{children}</>
}

export default RouteGuard
