# Earth Jukebox

Earth Jukebox turns NASA Earth-observation imagery into an interactive, browser-based soundscape.

Built for **The Earth Information Jukebox**, NASA Space Apps Challenge 2026.

## How it works

The app requests global imagery from NASA GIBS, draws the image into a fixed 1440 × 720 browser canvas, and reads its pixels. GIBS colormaps map pixel colors to measurement-value bins; the app uses each bin's midpoint as an explicitly approximate value. A west-to-east scan maps sampled values to instrument timbres and intensities, while latitude maps to pitch in a pentatonic scale. The Web Audio API creates the sound locally in the browser.

## Data and attribution

Imagery and layer metadata are provided by NASA's Global Imagery Browse Services (GIBS), part of NASA Earthdata:

- GHRSST Level 4 MUR sea-surface temperature
- GPM IMERG precipitation rate
- AMSR-E / AMSR2 sea-ice concentration
- MODIS Terra 16-day NDVI and recent VIIRS NOAA-21 rolling 8-day NDVI

Layer availability and dates vary by product. Product colormaps and time dimensions are read from GIBS capabilities at runtime. NASA GIBS imagery and metadata are credited to NASA Earthdata; this project is an independent educational sonification and is not an official NASA product or endorsement.

## Run locally

Requires Node.js 20.19+ or 22.12+.

```sh
npm install
npm run dev
npm run build
npm run preview
```

No API key or application backend is required. Browsers require a user gesture before Web Audio playback can start. GIBS access depends on network availability and the service's CORS policy.

## Limitations

- Pixel colors represent colormap bins, not the full-precision source measurements; displayed values are bin-midpoint estimates.
- Data are not available for every requested day. The app follows product cadence tolerances and shows “Not available” rather than substituting an out-of-range date.
- The AMSR-E and AMSR2 sea-ice archive ends at 2025-09-01; later requests use the latest earlier same-calendar-day archive when one is advertised.
- NDVI switches between recent VIIRS and historical MODIS Terra outside comparison mode. Historical comparisons use MODIS Terra for both dates; different sensors are not treated as directly comparable.
- Some products have limited temporal coverage or missing dates. A valid HTTP response alone is not treated as proof of data; the app checks canvas pixels against the product colormap.
