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
- PACE OCI chlorophyll-a, MODIS Terra water vapor and cloud optical thickness
- VIIRS Suomi-NPP day/night-band at-sensor radiance

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
- When no NDVI composite is close enough, the app may use the latest published composite on or before the requested day and labels its age. It never uses a future composite for an earlier request.
- PACE chlorophyll and VIIRS night radiance have shorter archives than the long-running MODIS products. Coverage varies with swath, clouds, and day/night acquisition; a colormap without declared units is labeled unitless.
- GIBS active-fire products advertise categorical, size-based map styles rather than a measurement colormap. They are not included as a numeric fire instrument; sonifying them as measured fire intensity would be misleading.
- Some products have limited temporal coverage or missing dates. A valid HTTP response alone is not treated as proof of data; the app checks canvas pixels against the product colormap.
