const plugin = require('tailwindcss/plugin');

module.exports = {
  content: [
    './src/**/*.{js,jsx,ts,tsx}',
    './index.html',
    './index_cgid.html',
  ],
  safelist: [
    'w-1/3',
    'w-1/2',
    'w-3/4',
    'block',
    'text-center',
    'justify-center',
    'flex',
    'flex-col',
    'flex-row',
    'items-center',
    'gap-4',
    'break-words',
    'max-w-full',
    {
      pattern: /^(p|px|py|pl|pr|pt|pb|m|mx|my|ml|mr|mt|mb)-(1|2|3|4|5|6|7|8|9|10|11|12|16|20|24|28|32)$/,
    },
  ],
  theme: {
    fontFamily: {
      default: ['Inter', 'sans-serif'],
      caption: ['Inter', 'sans-serif'],
    },
    extend: {
      colors: {
        palette: {
          warning: {
            950: "#190f00",
            900: "#331e00",
            800: "#663c00",
            700: "#945600",
            600: "#c77400",
            500: "#f99100",
            400: "#ffa82e",
            300: "#ffbd61",
            200: "#ffd599",
            100: "#ffeacc",
            50: "#fff4e5",
          },
          success: {
            950: "#01130c",
            900: "#022717",
            800: "#04492c",
            700: "#067044",
            600: "#079258",
            500: "#09b76e",
            400: "#0cf393",
            300: "#4bf6af",
            200: "#85f9c9",
            100: "#c5fce5",
            50: "#e2fef2",
          },
          info: {
            950: "#000e14",
            900: "#001b29",
            800: "#003a57",
            700: "#005580",
            600: "#0074ad",
            500: "#008ed6",
            400: "#14b1ff",
            300: "#4dc3ff",
            200: "#8ad8ff",
            100: "#e0f5ff",
            50: "#e0f5ff",
          },
          error: {
            950: "#160304",
            900: "#2c0708",
            800: "#540d0f",
            700: "#801418",
            600: "#a81a1f",
            500: "#d32127",
            400: "#e2464b",
            300: "#ea767a",
            200: "#f1a2a5",
            100: "#f8d3d4",
            50: "#fce9ea",
          },
          dark: {
            950: "#040406",
            900: "#060709",
            800: "#0d0d12",
            700: "#15161e",
            600: "#1b1d27",
            500: "#222430",
            400: "#282a39",
            300: "#393c51",
            200: "#9094b0",
            100: "#cccedb",
            50: "#e7e8ee",
          },
          light: {
            950: "#171717",
            900: "#303030",
            800: "#616161",
            700: "#919191",
            600: "#dedede",
            500: "#f1f1f1",
            400: "#f5f5f5",
            300: "#f7f7f7",
            200: "#fafafa",
            100: "#fcfcfc",
            50: "#fcfcfc",
          },
          brand: {
            950: "#070813",
            900: "#0d0f26",
            800: "#1a1e4c",
            700: "#272d72",
            600: "#333b94",
            500: "#404bbb",
            400: "#636cca",
            300: "#8d93d8",
            200: "#b3b7e5",
            100: "#d9dbf2",
            50: "#ecedf8",
          },
          transparent: 'rgba(255,255,255,0.03)',
          darkTransparent: 'rgba(0,0,0,0.5)',
          darkTransparentHover: 'rgba(0,0,0,0.6)',
          brand500LightTransparent: 'rgba(64, 75, 187, 0.1)',
          brand500Transparent: 'rgba(64, 75, 187, 0.2)',
          transparentError: 'rgba(228, 108, 108, 0.1)',
        }
      }
    },
  },
  plugins: [
    require('@tailwindcss/forms'),
    require('@tailwindcss/typography'),
    require('@tailwindcss/aspect-ratio'),
    plugin(function ({ addComponents, theme }) {
      addComponents({
        '.rounded-cg': {
          borderRadius: '9px'
        },
        '.rounded-b-cg': {
          borderBottomLeftRadius: '9px',
          borderBottomRightRadius: '9px'
        },
        '.cg-border-s': {
          borderRadius: '4px'
        },
        '.cg-border-m': {
          borderRadius: '6px'
        },
        '.cg-border-l': {
          borderRadius: '8px'
        },
        '.cg-border-xl': {
          borderRadius: '12px'
        },
        '.cg-border-xxl': {
          borderRadius: '16px'
        },

        // Typography
        '.cg-heading-1': {
          fontWeight: 600,
          fontSize: '37.32px',
          lineHeight: '130%',
          letterSpacing: '-1.12px',
        },
        '.cg-heading-2': {
          fontWeight: 600,
          fontSize: '25.92px',
          lineHeight: '130%',
          letterSpacing: '-0.778px',
        },
        '.cg-heading-3': {
          fontWeight: 600,
          fontSize: '20.2px',
          lineHeight: '130%',
          letterSpacing: '-0.606px',
        },
        '.cg-heading-4': {
          fontWeight: 600,
          fontSize: '18px',
          lineHeight: '28px',
        },
        '.cg-heading-5': {
          fontWeight: 600,
          fontSize: '16px',
          lineHeight: '24px',
        },
        '.cg-heading-6': {
          fontWeight: 600,
          fontSize: '14px',
          lineHeight: '20px',
        },
        '.cg-text-lg-400': {
          fontWeight: 400,
          fontSize: '15px',
          lineHeight: '130%',
          letterSpacing: '-0.011em',
        },
        '.cg-text-lg-500': {
          fontWeight: 500,
          fontSize: '15px',
          lineHeight: '130%',
          letterSpacing: '-0.011em',
        },
        '.cg-text-md-400': {
          fontWeight: 400,
          fontSize: '14.2px',
          lineHeight: '130%',
          letterSpacing: '-0.006em',
        },
        '.cg-text-md-500': {
          fontWeight: 500,
          fontSize: '14.2px',
          lineHeight: '130%',
          letterSpacing: '-0.006em',
        },
        '.cg-text-sm-400': {
          fontWeight: 400,
          fontSize: '12.6px',
          lineHeight: '130%',
        },
        '.cg-text-sm-500': {
          fontWeight: 500,
          fontSize: '12.6px',
          lineHeight: '130%',
        },
        '.cg-caption-md-400-no-transform': {
          fontWeight: 400,
          fontSize: '12px',
          lineHeight: '16px',
        },
        '.cg-caption-md-400': {
          fontWeight: 400,
          fontSize: '12px',
          lineHeight: '16px',
          textTransform: 'uppercase',
        },
        '.cg-caption-md-600': {
          fontWeight: 600,
          fontSize: '12px',
          lineHeight: '16px',
          textTransform: 'uppercase',
        },

        // box-shadows
        '.cg-box-shadow-sm': {
          boxShadow: '0px 0px 1px rgba(0, 0, 0, 0.2), 0px 1px 4px rgba(0, 0, 0, 0.06)',
        },
        '.cg-box-shadow-md': {
          boxShadow: '0px 0px 1px rgba(0, 0, 0, 0.16), 0px 2px 10px rgba(0, 0, 0, 0.08)',
        },
        '.cg-box-shadow-lg': {
          boxShadow: '0px 0px 2px rgba(0, 0, 0, 0.08), 0px 4px 16px rgba(0, 0, 0, 0.16)',
        },
        '.cg-box-shadow-xl': {
          boxShadow: '0px 0px 4px rgba(0, 0, 0, 0.08), 0px 6px 32px rgba(0, 0, 0, 0.16)',
        },
      });
    })
  ],
}
