// Checks that a package URL resolves to the right place on both origins.
//
//   node check-paths.mjs
import { packageUrl } from './lib/flash.mjs'
import { done, eq } from './check.mjs'

const mirror = 'https://rom.flac.moe'
const url = `${mirror}/bronco/latest/additional_images-22.10.2026.zip`

// production: the page is served from the mirror, so the real URL is used as-is
eq('mirror origin keeps the real url', packageUrl(url, mirror), url)

// dev: any other origin goes through serve.py's /pkg/ proxy (the mirror sends no CORS headers)
eq('localhost goes through the proxy', packageUrl(url, 'http://localhost:8080'), '/pkg/bronco/latest/additional_images-22.10.2026.zip')

// a relative url resolves against the page origin, i.e. it is served as-is
eq('relative url stays relative', packageUrl('bronco/latest/x.zip', mirror), `${mirror}/bronco/latest/x.zip`)

done()
