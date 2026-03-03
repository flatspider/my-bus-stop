export default function StaleDataBanner({ visible, staleSeconds }: { visible: boolean; staleSeconds: number }) {
  const minutes = Math.max(1, Math.floor(staleSeconds / 60))
  return (
    <div className={`stale-banner ${visible ? 'stale-banner--visible' : ''}`}>
      <span className="stale-banner__dot" />
      <span className="stale-banner__text">Last updated {minutes} min ago</span>
    </div>
  )
}
