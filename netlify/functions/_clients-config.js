// HANDS Logistics — Client Configuration Registry
// Single source of truth for all client portal configs. Imported by every
// Booqable-related Netlify function. Adding a new client = add a new entry
// here + commit + add the matching env var (e.g. BOOQABLE_KEY_<SLUG>) in
// Netlify Site config → Environment variables.
//
// IMPORTANT: this file gets bundled into each function deploy. Updating it
// requires a redeploy (commit triggers Netlify auto-build).
//
// Sensitive fields:
//   password_sha256 — SHA-256 of the portal access password (also checked
//                     client-side for the gate; this is access-control theater,
//                     not real auth — Booqable still gates the actual data)
//   booqable_env_var — name of the env var that holds the API key
//
// Public fields:
//   slug, name, short_name, monday.* (used in WBS code), ui.* (UI strings)

module.exports = {

  wgs: {
    slug: 'wgs',
    name: 'William Grant & Sons',
    short_name: 'WGS',
    booqable_subdomain: 'williamgs',
    booqable_env_var: 'BOOQABLE_KEY_WGS',
    password_sha256: 'd05d6f0708fe70a3e8568e8d7a867cae428cb5a744f49cd49bc99727610b0090',
    notify_emails: ['jon@handslogistics.com'],
    monday: {
      ops_board: '4550650855',
      wbs_prefix: 'WGS'
    },
    ui: {
      hero_eyebrow: 'Asset Deployment · Las Vegas',
      catalog_eyebrow: 'WGS Inventory',
      catalog_title: 'Your Assets'
    }
  }

  // To add a new client (e.g. Ghost Beverage):
  //   ghost: {
  //     slug: 'ghost',
  //     name: 'GHOST Beverage',
  //     short_name: 'GHOST',
  //     booqable_subdomain: '<their-subdomain>',
  //     booqable_env_var: 'BOOQABLE_KEY_GHOST',
  //     password_sha256: '<sha256 of their access code>',
  //     notify_emails: ['jon@handslogistics.com'],
  //     monday: { ops_board: '8745692835', wbs_prefix: 'GHOST' },
  //     ui: { ... }
  //   }
  // Then in Netlify, add env var BOOQABLE_KEY_GHOST with their API key,
  // and copy booqable-webhook-wgs.js → booqable-webhook-ghost.js (change SLUG).

};
