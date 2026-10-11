# LUMÉ BEAUTY — Tienda web

Tienda online de skincare coreano, perfumes y body mist. Interfaz en español, armada con
componentes HTML declarativos (`.dc.html`) y un catálogo en JSON.

## Estructura

| Ruta | Qué es |
| --- | --- |
| `Lume Beauty.dc.html` | Página principal: arma el layout e importa los componentes |
| `Header.dc.html`, `Footer.dc.html` | Navegación, buscador y pie de página |
| `HeroBanner.dc.html` | Banner principal del home |
| `CategoryBanners.dc.html` | Accesos a categorías y marcas |
| `FeaturedProducts.dc.html`, `ProductCard.dc.html` | Grilla de destacados y ficha de producto |
| `CartDrawer.dc.html` | Carrito lateral |
| `AnnouncementBar.dc.html` | Barra de avisos superior |
| `data/catalog.json` | Catálogo: categorías, marcas, productos y precios (ARS) |
| `assets/` | Imágenes usadas por el sitio (hero, categorías, productos) |
| `uploads/` | Imágenes originales sin procesar |
| `_ds/` | Design system de referencia (Nocturne) |
| `support.js` | Runtime que interpreta los componentes `.dc.html` |

## Catálogo

Categorías: **Skincare coreano** y **Perfumes & body mist**.
Marcas: Medicube, Numbuzin y Victoria's Secret.

Para cambiar productos, precios o stock se edita `data/catalog.json`; no hace falta tocar los
componentes.

## Cómo verlo

Los archivos `.dc.html` necesitan servirse por HTTP (cargan `support.js` y el catálogo por fetch):

```bash
python -m http.server 8000
```

Luego abrir <http://localhost:8000/Lume%20Beauty.dc.html>.

## Diseño

Paleta cálida en tonos nude y terracota (`#f3eae4` de fondo, `#4a231f` para títulos), tipografías
Cormorant Garamond para títulos y Jost para texto.
