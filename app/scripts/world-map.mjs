#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
/**
 * Regenerates src/components/apps/world-map.json: one projected SVG path per
 * country, keyed by ISO 3166-1 alpha-2, the code Cloudflare's Cf-Ipcountry
 * header carries. The Access tab's map draws from it, so the map is the
 * app's own and needs no Grafana session in the viewer's browser.
 *
 * Source: Natural Earth 1:110m admin-0 countries, plus 1:50m label points
 * for the states too small for 1:110m (public domain), projected
 * with Equal Earth. ISO_A2_EH rather than ISO_A2, which is -99 for France and
 * Norway. Run in a throwaway container; the output is committed:
 *
 *   podman run --rm --dns 8.8.8.8 -v "$PWD":/w -w /w node:24 sh -c \
 *     'npm i --no-save --prefix /tmp/m d3-geo@3 && NODE_PATH=/tmp/m/node_modules node scripts/world-map.mjs'
 */
import { createRequire } from 'node:module'

const require = createRequire(`${process.env.NODE_PATH}/`)
const { geoEqualEarth, geoPath } = require('d3-geo')

const BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/'
const WIDTH = 1000
const HEIGHT = 487

const load = async (scale) => (await fetch(`${BASE}ne_${scale}_admin_0_countries.geojson`)).json()
const geo = await load('110m')
const fine = await load('50m')
// Antarctica only takes room: no request comes from it.
geo.features = geo.features.filter((f) => f.properties.ISO_A2_EH !== 'AQ')

const projection = geoEqualEarth().fitSize([WIDTH, HEIGHT], geo)
const path = geoPath(projection).digits(1)

const countries = {}
for (const f of geo.features) {
  const code = f.properties.ISO_A2_EH
  const d = path(f)
  if (!/^[A-Z]{2}$/.test(code) || d === null) continue
  countries[code] = { name: f.properties.NAME, d }
}

// States too small for 1:110m (Singapore, Malta, Bahrain…) become a dot at
// the 1:50m label point, so a request from one still lands on the map.
const dots = {}
for (const f of fine.features) {
  const code = f.properties.ISO_A2_EH
  if (!/^[A-Z]{2}$/.test(code) || code in countries || code === 'AQ') continue
  const xy = projection([f.properties.LABEL_X, f.properties.LABEL_Y])
  if (xy === null) continue
  dots[code] = {
    name: f.properties.NAME,
    x: Math.round(xy[0] * 10) / 10,
    y: Math.round(xy[1] * 10) / 10,
  }
}

writeFileSync(
  new URL('../src/components/apps/world-map.json', import.meta.url),
  `${JSON.stringify({ viewBox: `0 0 ${WIDTH} ${HEIGHT}`, countries, dots })}\n`,
)
console.log(`${Object.keys(countries).length} countries, ${Object.keys(dots).length} dots`)
