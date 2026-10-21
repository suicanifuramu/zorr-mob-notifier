// Manual refresh from the audited research snapshot. The normal Pages build
// consumes the generated data/ and public/assets/; it never executes game code.
//
// Atlas frames are physical slots. Catalog IDs are semantic IDs and are kept
// untouched, but they are never used to place or crop art: runtime items are
// looked up by slug so a reordered runtime cannot shift icons between names.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const research = new URL('../research/', import.meta.url);
const cellSize = 128;
// The audited snapshot currently has 179 mobs and 575 petals. Petals share one
// frame per distinct `count` among rarities 0..7 (607 frames in this snapshot).
const expectedFrames = { mobs: 179, petals: 607 };

const slugify = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

function uniqueBySlug(items, label) {
  if (!Array.isArray(items)) throw new Error(`${label} must be an array`);
  const map = new Map();
  for (const item of items) {
    const slug = item?.slug;
    if (typeof slug !== 'string' || !slug) throw new Error(`${label} has an item without a slug`);
    if (map.has(slug)) throw new Error(`${label} has duplicate slug "${slug}"`);
    map.set(slug, item);
  }
  return map;
}

function assertUniqueNames(items, label) {
  const seen = new Map();
  for (const item of items) {
    if (typeof item?.name !== 'string' || !item.name) throw new Error(`${label} has an item without a name`);
    if (seen.has(item.name)) throw new Error(`${label} has duplicate name "${item.name}"`);
    seen.set(item.name, item);
  }
}

function assertSameSlugs(catalogItems, runtimeBySlug, label) {
  const expected = new Set();
  for (const item of catalogItems) {
    if (!item?.slug) throw new Error(`catalog ${label} has an item without a slug`);
    if (expected.has(item.slug)) throw new Error(`catalog ${label} has duplicate slug "${item.slug}"`);
    expected.add(item.slug);
  }
  const missing = [...expected].filter(slug => !runtimeBySlug.has(slug));
  const extra = [...runtimeBySlug.keys()].filter(slug => !expected.has(slug));
  if (missing.length || extra.length) {
    throw new Error(`${label} slug coverage changed; missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`);
  }
}

function assertFrameCoverage(frames, cells, label) {
  if (frames.length !== cells) throw new Error(`${label} frame count ${frames.length} does not match ${cells}`);
  const seen = new Set();
  for (const [position, frame] of frames.entries()) {
    if (frame.index !== position) throw new Error(`${label} frame ${position} has index ${frame.index}`);
    if (seen.has(frame.index)) throw new Error(`${label} frame ${frame.index} is assigned twice`);
    if (!Number.isInteger(frame.index) || frame.index < 0 || frame.index >= cells) {
      throw new Error(`${label} frame ${frame.index} is outside 0..${cells - 1}`);
    }
    seen.add(frame.index);
  }
  if (seen.size !== cells) throw new Error(`${label} frames do not cover all ${cells} cells`);
}

/**
 * Build the physical atlas plan from catalog entries and audited runtime data.
 * Semantic IDs stay on the catalog objects; iconIndex/iconIndices are physical.
 */
export function buildAssetPlan({ catalogMobs, catalogPetals, runtimeMobs, runtimePetals, countsByRarity }) {
  assertUniqueNames(catalogMobs, 'catalog mobs');
  assertUniqueNames(catalogPetals, 'catalog petals');
  assertUniqueNames(runtimeMobs, 'runtime mobs');
  assertUniqueNames(runtimePetals, 'runtime petals');

  const runtimeMobBySlug = uniqueBySlug(runtimeMobs, 'runtime mobs');
  const runtimePetalBySlug = uniqueBySlug(runtimePetals, 'runtime petals');
  const countsBySlug = uniqueBySlug(countsByRarity, 'petal counts');
  assertSameSlugs(catalogMobs, runtimeMobBySlug, 'mobs');
  assertSameSlugs(catalogPetals, runtimePetalBySlug, 'petals');
  assertSameSlugs(catalogPetals, countsBySlug, 'petal counts');

  // Mobs use one physical frame per catalog entry, in stable catalog order.
  const mobFrames = catalogMobs.map((mob, index) => ({ index, slug: mob.slug }));
  const mobs = catalogMobs.map((mob, iconIndex) => ({ ...mob, iconIndex }));

  // Petals share a frame for every rarity whose count is equal, but a petal
  // whose count changes with rarity gets a distinct frame for each count.
  const petalFrames = [];
  const petals = catalogPetals.map(petal => {
    const counts = countsBySlug.get(petal.slug)?.counts;
    if (!Array.isArray(counts) || counts.length < 8) {
      throw new Error(`Petal "${petal.slug}" is missing counts for rarities 0..7`);
    }
    const frameByCount = new Map();
    const iconIndices = [];
    for (let rarity = 0; rarity < 8; rarity++) {
      const count = counts[rarity];
      if (!Number.isInteger(count) || count < 0) {
        throw new Error(`Petal "${petal.slug}" has invalid count ${count} at rarity ${rarity}`);
      }
      let index = frameByCount.get(count);
      if (index === undefined) {
        index = petalFrames.length;
        frameByCount.set(count, index);
        petalFrames.push({ index, slug: petal.slug, count, rarity });
      }
      iconIndices.push(index);
    }
    if (iconIndices.length !== 8) throw new Error(`Petal "${petal.slug}" has invalid icon coverage`);
    return { ...petal, iconIndices };
  });

  assertFrameCoverage(mobFrames, mobs.length, 'mob');
  assertFrameCoverage(petalFrames, petalFrames.length, 'petal');

  for (const frame of petalFrames) {
    if (!runtimePetalBySlug.has(frame.slug)) throw new Error(`Petal frame ${frame.index} has no runtime petal`);
  }

  return {
    mobs,
    petals,
    frames: { mobs: mobFrames, petals: petalFrames },
    cells: { mobs: mobs.length, petals: petalFrames.length },
  };
}

/** Physical atlas dimensions, including unused cells in the final row. */
export function atlasLayout(cells, columns, size = cellSize) {
  if (!Number.isInteger(cells) || cells < 1) throw new Error(`Invalid atlas cell count ${cells}`);
  if (!Number.isInteger(columns) || columns < 1) throw new Error(`Invalid atlas column count ${columns}`);
  return { width: columns * size, height: Math.ceil(cells / columns) * size, columns, size };
}

async function loadFont(existingSource) {
  const fontPath = new URL('public/assets/fredoka-one.ttf', root);
  const licensePath = new URL('public/licenses/Fredoka-One-OFL.txt', root);
  try {
    const font = await readFile(fontPath);
    const digest = createHash('sha256').update(font).digest('hex');
    if (existingSource?.fontSha256 && digest !== existingSource.fontSha256) {
      throw new Error('Local Fredoka One font hash changed');
    }
    await readFile(licensePath, 'utf8');
    return { font, fontURL: existingSource?.fontURL, fontSha256: digest, reused: true };
  } catch (error) {
    // Bootstrap path: fetch the audited font and its OFL text when absent.
    // Any other read/hash failure (for example a changed local font) is fatal.
    if (error?.code !== 'ENOENT') throw error;
  }
  const fontCSS = new URL('https://fonts.googleapis.com/css2');
  fontCSS.searchParams.set('family', 'Fredoka One');
  fontCSS.searchParams.set('text', String.fromCharCode(...Array.from({ length: 95 }, (_, i) => i + 32)) + '–…');
  const response = await fetch(fontCSS, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Font stylesheet: ${response.status}`);
  const fontURL = (await response.text()).match(/src:\s*url\(([^)]+)\)/)?.[1];
  if (!fontURL) throw new Error('Font URL missing');
  const fontResponse = await fetch(fontURL, { signal: AbortSignal.timeout(30000) });
  if (!fontResponse.ok) throw new Error(`Font: ${fontResponse.status}`);
  const font = Buffer.from(await fontResponse.arrayBuffer());
  await writeFile(fontPath, font);
  const fontLicenseURL = 'https://raw.githubusercontent.com/google/fonts/be2838a23fd2918408e22b25c54135da76525ff6/ofl/fredokaone/OFL.txt';
  const licenseResponse = await fetch(fontLicenseURL, { signal: AbortSignal.timeout(30000) });
  if (!licenseResponse.ok) throw new Error(`Font license: ${licenseResponse.status}`);
  await mkdir(new URL('public/licenses/', root), { recursive: true });
  await writeFile(licensePath, await licenseResponse.text());
  return { font, fontURL, fontSha256: createHash('sha256').update(font).digest('hex'), reused: false };
}

async function main() {
  const game = JSON.parse(await readFile(new URL('extracted-game.json', research)));
  const dropData = JSON.parse(await readFile(new URL('mob-drops.json', research)));
  const variantData = JSON.parse(await readFile(new URL('variant-drops.json', research)));
  const source = await readFile(new URL('zorr-deobfuscator/deobfuscated/1K580MS96-deobfuscated.js', research), 'utf8');
  const runtime = await readFile(new URL('extracted-runtime.js', research), 'utf8');
  const variantBlock = source.match(/var I = N\(\{([\s\S]*?)\}\);/);
  if (!variantBlock) throw new Error('Variant enumeration changed');
  const names = [...variantBlock[1].matchAll(/(\w+):\s*1/g)].map(m => m[1]);
  if (names.length !== 18) throw new Error('Expected 18 audited variants');
  const paletteBlock = source.match(/const jS = (\{[\s\S]*?\n\s*\});/);
  if (!paletteBlock) throw new Error('Variant color table changed');
  const palette = vm.runInNewContext(`(${paletteBlock[1]})`, { I: Object.fromEntries(names.map(n => [n, n])) }, { timeout: 1000 });

  const catalogMobs = dropData.mobs.map(m => ({
    id: m.id,
    name: m.name,
    slug: m.slug,
    drops: m.drops.filter(d => d.resolved).map(d => [d.petal, d.effectiveParameter]),
  }));
  const catalogPetals = game.petals.map(p => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    pet: !!p.pet,
    magicPetal: p.magicPetal?.slug || null,
  }));

  const existingSource = await readFile(new URL('data/assets-source.json', root), 'utf8')
    .then(text => JSON.parse(text)).catch(() => null);
  const font = await loadFont(existingSource);

  // Execute the audited runtime only inside the browser sandbox to read its
  // definitions; the asset build itself never runs game code in Node.
  const chromiumPackage = (await import('@sparticuz/chromium')).default;
  const { chromium: playwright } = await import('playwright-core');
  const browser = await playwright.launch({
    executablePath: await chromiumPackage.executablePath(),
    args: chromiumPackage.args,
    headless: true,
  });
  let plan, atlases;
  try {
    const page = await browser.newPage();
    const runtimeData = await page.evaluate(runtimeSource => {
      window.IS_PROD = true;
      globalThis.timeElapsed = 0;
      CanvasRenderingContext2D.prototype.As = function (s) { this.scale(s, s); };
      new Function(runtimeSource)();
      const summarize = item => ({ id: item.id, name: item.name, slug: item.slug });
      return {
        mobs: result.mobs.map(summarize),
        petals: result.petals.map(summarize),
      };
    }, runtime);

    plan = buildAssetPlan({
      catalogMobs,
      catalogPetals,
      runtimeMobs: runtimeData.mobs,
      runtimePetals: runtimeData.petals,
      countsByRarity: game.countsByRarity,
    });
    if (plan.cells.mobs !== expectedFrames.mobs || plan.cells.petals !== expectedFrames.petals) {
      throw new Error(`Expected ${expectedFrames.mobs} mob and ${expectedFrames.petals} petal frames, got ${plan.cells.mobs} and ${plan.cells.petals}`);
    }

    atlases = await page.evaluate(async ({ runtimeSource, font, plan, layout }) => {
      window.IS_PROD = true;
      globalThis.timeElapsed = 0;
      CanvasRenderingContext2D.prototype.As = function (s) { this.scale(s, s); };
      new Function(runtimeSource)();
      const face = new FontFace('Fredoka One', `url(data:font/ttf;base64,${font})`);
      await face.load();
      document.fonts.add(face);

      const mobsBySlug = new Map(result.mobs.map(item => [item.slug, item]));
      const petalsBySlug = new Map(result.petals.map(item => [item.slug, item]));
      const render = (kind, frames, view) => {
        const sheet = document.createElement('canvas');
        sheet.width = view.width;
        sheet.height = view.height;
        const out = sheet.getContext('2d');
        const cell = document.createElement('canvas');
        cell.width = cell.height = view.size;
        const ctx = cell.getContext('2d');
        const used = new Set();
        for (const frame of frames) {
          if (used.has(frame.index)) throw new Error(`${kind} frame ${frame.index} assigned twice`);
          used.add(frame.index);
          if (frame.index < 0 || frame.index >= view.cells) throw new Error(`${kind} frame ${frame.index} out of atlas bounds`);
          const item = (kind === 'mob' ? mobsBySlug : petalsBySlug).get(frame.slug);
          if (!item) throw new Error(`${kind} frame ${frame.index} has no runtime item for slug ${frame.slug}`);
          cell.width = view.size;
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, view.size, view.size);
          ctx.clip();
          if (kind === 'mob') {
            ctx.scale(view.size, view.size);
            result.mobDraw(ctx, item);
          } else {
            ctx.scale(view.size / 80, view.size / 80);
            result.draw(ctx, item, frame.rarity);
            result.label(ctx, item);
          }
          ctx.restore();
          out.drawImage(cell, (frame.index % view.columns) * view.size, Math.floor(frame.index / view.columns) * view.size);
        }
        if (used.size !== view.cells) throw new Error(`${kind} atlas rendered ${used.size}/${view.cells} frames`);
        return sheet.toDataURL('image/png').split(',')[1];
      };

      const mobView = { ...layout.mobs, cells: plan.cells.mobs };
      const petalView = { ...layout.petals, cells: plan.cells.petals };
      return {
        mob: render('mob', plan.frames.mobs, mobView),
        petal: render('petal', plan.frames.petals, petalView),
        layouts: { mob: mobView, petal: petalView },
      };
    }, {
      runtimeSource: runtime,
      font: font.font.toString('base64'),
      plan,
      layout: {
        mobs: atlasLayout(plan.cells.mobs, 14, cellSize),
        petals: atlasLayout(plan.cells.petals, 20, cellSize),
      },
    });
  } finally {
    await browser.close();
  }

  const catalog = {
    schemaVersion: 1,
    source: { script: 'https://zorr.pages.dev/1K580MS96.js', sha256: dropData.identity.sha256, snapshotDate: '2026-10-21' },
    rendering: { font: game.rendering.font, cellSize, mobColumns: 14, petalColumns: 20, mobCells: plan.cells.mobs, petalCells: plan.cells.petals },
    rarities: dropData.rarities.map(r => ({ ...r, slug: slugify(r.name) })),
    variants: names.map((name, id) => ({
      id,
      name,
      slug: slugify(name),
      color: palette[name] ? `hsl(${palette[name][0]} ${palette[name][1]}% 65%)` : ({
        Magic: '#29e9ef', Arcane: '#ff9242', Cursed: '#a0a0a0', Shiny: '#ffe68c', Corrupt: '#b38bd8', Radiant: '#9a8bff',
      }[name] || '#edf3ef'),
    })),
    petals: plan.petals,
    mobs: plan.mobs,
    variantDrops: Object.fromEntries(variantData.variants.map(v => [slugify(v.variant), v.drops.map(d => [d.petal, d.effectiveParameter])])),
    flashDrops: [['fractal', 0.1], ['lithium', 0.2], ['usain_bolt', 0.2], ['hel_lightning', 0.2], ['lightning', 0.3]],
  };
  // Flash has a weighted extra candidate, so the filter uses the set of possibilities.
  catalog.variantDrops.flash = [['ticket', 0.005], ...catalog.flashDrops];

  await mkdir(new URL('data/', root), { recursive: true });
  await mkdir(new URL('public/assets/', root), { recursive: true });
  const { layouts, ...pngs } = atlases;
  for (const [kind, png] of Object.entries(pngs)) {
    const bytes = Buffer.from(png, 'base64');
    if (bytes.subarray(1, 4).toString() !== 'PNG') throw new Error(`${kind} atlas is not a PNG`);
    const expected = layouts[kind];
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width !== expected.width || height !== expected.height) {
      throw new Error(`${kind} atlas is ${width}x${height}, expected ${expected.width}x${expected.height}`);
    }
    await writeFile(new URL(`public/assets/${kind}-atlas.png`, root), bytes);
    console.log(`${kind}: ${bytes.length} bytes, ${width}x${height}, ${plan.cells[kind === 'mob' ? 'mobs' : 'petals']} cells`);
  }
  await writeFile(new URL('data/catalog.json', root), JSON.stringify(catalog));
  await writeFile(new URL('data/assets-source.json', root), JSON.stringify({
    source: catalog.source,
    renderer: 'Chromium',
    fontURL: font.fontURL,
    fontSha256: font.fontSha256,
  }, null, 2));
  console.log(`${catalog.mobs.length} mobs (${catalog.rendering.mobCells} frames), ${catalog.petals.length} petals (${catalog.rendering.petalCells} frames), ${names.length} variants`);
  if (!font.reused) console.log('Font and OFL refreshed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
