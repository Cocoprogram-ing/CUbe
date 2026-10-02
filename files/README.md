# Block Platform

A tiny multiplayer 3D block game: explore a generated world, then break and place blocks together.

- Terrain is generated from a **seed**: oceans, beaches, deserts, grassy hills, rocky mountains and snowy peaks.
- Blocks: grass, dirt, stone, sand, wood, wood planks, leaves, cobblestone, snow (plus water and bedrock).
- Oak **trees** grow in forests and scattered through grassland.
- The world is endless on x/z (up to ±30,000 blocks) and streams in around you.

## Project layout

    server.js            Node server (Express + WebSocket)
    public/index.html    The game (Three.js client)
    public/worldgen.js   Seeded world generator, shared by the server and the browser
    package.json
    render.yaml

`worldgen.js` must be in `public/` next to `index.html`: the browser loads it directly and the server
`require`s it. Both run the same code, so the same seed gives the same world everywhere. Only the seed and
player changes are sent over the network, not the terrain.

## Run locally

    npm install
    npm start

Open http://localhost:3000 in two browser tabs to see multiplayer working.

## Choosing a seed

The seed is picked by the **server**, so everyone in the same game shares one world.

- Default: a new random seed every time the server starts.
- Fixed seed: set the `SEED` environment variable (any text or number works).

Locally:

    SEED=myworld npm start          # macOS / Linux
    set SEED=myworld && npm start   # Windows cmd

On Render: open your service > **Environment** > add `SEED` = `myworld` > save (it redeploys).

The current seed is shown at the top-left of the game, under the player count.

## Deploy (GitHub + Render)

1. Create a new GitHub repo and push this folder to it:

       git init
       git add .
       git commit -m "Block Platform"
       git branch -M main
       git remote add origin https://github.com/YOUR_USER/block-platform.git
       git push -u origin main

2. On https://render.com: New + > Web Service > connect the repo.
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: Free
   (Or choose New + > Blueprint, which reads `render.yaml` automatically.)

3. When the deploy finishes, open your `.onrender.com` URL and share it.

## Controls

W A S D move, Space jump (or swim up), Shift run, left click break, right click place,
1-9 or mouse wheel to pick a block, Esc to release the mouse.

## Notes

- Terrain is regenerated from the seed, so only player edits live in server memory (capped at 100,000 changes).
  Edits reset when the server restarts/redeploys; with a fixed `SEED` the *terrain* comes back identical.
- Render's free tier sleeps after ~15 minutes without traffic; the first visit afterwards takes ~30-60 s to wake up.
- If the game runs slowly on a weak computer, lower `RENDER_DIST` at the top of the script in `public/index.html`.
- Desktop only (keyboard + mouse).
