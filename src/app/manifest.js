export default function manifest() {
  return {
    name: '9Router - AI Infrastructure Management',
    short_name: '9Router',
    description: 'One endpoint for all your AI providers. Manage keys, monitor usage, and scale effortlessly.',
    id: '/dashboard',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    background_color: '#0a0a0a',
    theme_color: '#0a0a0a',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/icon-512.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  }
}
