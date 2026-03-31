// ── All game commands (Tiers 6-18) ────────────────────────────────────────────
// Wires items, recipes, shops, quests, slayer, trading, and all remaining systems

const commands = require('../engine/commands');
const items = require('../data/items');
const recipes = require('../data/recipes');
const shops = require('../data/shops');
const quests = require('../data/quests');
const droptables = require('../data/droptables');
const slayer = require('../data/slayer');

module.exports = function registerAll(ctx) {
  const { players, playersByName, groundItems, tick, events, persistence,
    tiles, walls, npcs, objects, pathfinding, combat, actions,
    getLevel, getXp, addXp, totalLevel, combatLevel,
    getBoostedLevel, calcWeight,
    invAdd, invRemove, invCount, invFreeSlots,
    send, sendText, broadcast, findPlayer, nextItemId } = ctx;

  // Helper: recalculate player weight
  function updateWeight(p) {
    if (calcWeight) calcWeight(p, (id) => items.get(id));
  }

  // ── Agility course definition ────────────────────────────────────────────
  const AGILITY_COURSES = {
    town_rooftop: {
      name: 'Town Rooftop Course',
      levelReq: 1,
      obstacles: [
        { name: 'Low wall', defId: 'agility_wall', x: 95, y: 80, xp: 8 },
        { name: 'Rooftop edge', defId: 'agility_rooftop', x: 95, y: 82, xp: 8 },
        { name: 'Gap', defId: 'agility_gap', x: 98, y: 80, xp: 10 },
        { name: 'Obstacle net', defId: 'agility_net', x: 101, y: 80, xp: 10 },
        { name: 'Balancing log', defId: 'agility_log', x: 104, y: 80, xp: 12 },
        { name: 'Ladder', defId: 'agility_ladder', x: 107, y: 80, xp: 12 },
      ],
      lapBonus: 30,
    },
  };

  // ── Eating food ─────────────────────────────────────────────────────────────
  commands.register('eat', { help: 'Eat food to heal: eat [item]', category: 'Items',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase();
      const slot = p.inventory.findIndex(s => s && s.name.toLowerCase() === name);
      if (slot < 0) return `You don't have "${name}".`;
      const item = p.inventory[slot];
      const heal = items.FOOD_HEAL[item.id];
      if (!heal) return `You can't eat ${item.name}.`;
      if (p.hp >= p.maxHp) return 'You are already at full health.';
      p.inventory[slot] = item.count > 1 ? { ...item, count: item.count - 1 } : null;
      const healed = Math.min(heal, p.maxHp - p.hp);
      p.hp += healed;
      return `You eat the ${item.name}. HP: ${p.hp}/${p.maxHp} (+${healed})`;
    }
  });

  // ── Bury bones ──────────────────────────────────────────────────────────────
  commands.register('bury', { help: 'Bury bones for Prayer XP: bury [bones]', category: 'Skills',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase() || 'bones';
      const slot = p.inventory.findIndex(s => s && s.name.toLowerCase().includes(name) && s.name.toLowerCase().includes('bone'));
      if (slot < 0) return `You don't have any bones.`;
      const item = p.inventory[slot];
      const xpMap = { 100: 4.5, 106: 15, 107: 72 }; // bones, big bones, dragon bones
      const xp = xpMap[item.id] || 4.5;
      p.inventory[slot] = item.count > 1 ? { ...item, count: item.count - 1 } : null;
      const lvl = addXp(p, 'prayer', xp);
      let msg = `You bury the ${item.name}. +${xp} Prayer XP.`;
      if (lvl) msg += ` Prayer level: ${lvl}!`;
      return msg;
    }
  });

  // ── Generic tick-based recipe processing ──────────────────────────────────
  function startRecipeAction(p, recipe, skill, verb, extraCheck) {
    if (getLevel(p, skill) < recipe.level) return `You need ${skill.charAt(0).toUpperCase() + skill.slice(1)} level ${recipe.level}.`;
    if (extraCheck) { const err = extraCheck(); if (err) return err; }
    for (const input of recipe.inputs) {
      if (invCount(p, input.id) < input.count) return `You need ${input.count}x ${items.get(input.id)?.name || 'item'}.`;
    }
    if (p.busy) actions.cancel(p);
    actions.start(p, {
      type: skill,
      ticks: recipe.ticks || 4,
      repeat: true,
      data: { recipe, player: p, skill, verb },
      onTick: (data, ticksLeft) => ticksLeft === (data.recipe.ticks || 4) - 1 ? `You begin to ${data.verb} ${data.recipe.name}...` : null,
      onComplete: (data) => {
        const r = data.recipe;
        const pl = data.player;
        // Check materials still available
        for (const input of r.inputs) { if (invCount(pl, input.id) < input.count) { actions.cancel(pl); return 'You run out of materials.'; } }
        // Fail chance (smelting iron)
        if (r.failChance && Math.random() < r.failChance) {
          for (const input of r.inputs) invRemove(pl, input.id, input.count);
          updateWeight(pl);
          return `You fail to ${data.verb} ${r.name}.`;
        }
        // Burn check (cooking)
        if (r.stopBurn) {
          const burnChance = Math.max(0, (r.stopBurn - getLevel(pl, data.skill)) / r.stopBurn);
          if (Math.random() < burnChance) {
            for (const input of r.inputs) invRemove(pl, input.id, input.count);
            if (r.failItem) invAdd(pl, r.failItem, items.get(r.failItem)?.name || 'Burnt food', 1);
            updateWeight(pl);
            return `You accidentally burn the ${r.name}.`;
          }
        }
        for (const input of r.inputs) invRemove(pl, input.id, input.count);
        for (const output of r.outputs) invAdd(pl, output.id, items.get(output.id)?.name || r.name, output.count, items.get(output.id)?.stackable);
        const lvl = addXp(pl, data.skill, r.xp);
        updateWeight(pl);
        let msg = `You ${data.verb} ${r.name}. +${r.xp} ${data.skill.charAt(0).toUpperCase() + data.skill.slice(1)} XP.`;
        if (lvl) msg += ` ${data.skill.charAt(0).toUpperCase() + data.skill.slice(1)} level: ${lvl}!`;
        // Can we repeat?
        for (const input of r.inputs) { if (invCount(pl, input.id) < input.count) { actions.cancel(pl); msg += ' You run out of materials.'; } }
        return msg;
      },
    });
    return `You begin to ${verb} ${recipe.name}...`;
  }

  // ── Cooking (tick-based) ─────────────────────────────────────────────────────
  commands.register('cook', { help: 'Cook food: cook [item]', category: 'Skills',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase();
      if (!name) {
        const available = recipes.forSkill('cooking').filter(r => getLevel(p, 'cooking') >= r.level);
        return 'Cooking recipes:\n' + available.map(r => `  ${r.name} (lvl ${r.level}, ${r.xp} XP, ${r.ticks}t)`).join('\n');
      }
      const recipe = recipes.forSkill('cooking').find(r => r.name.toLowerCase() === name || r.outputs[0]?.id === items.find(name)?.id);
      if (!recipe) return `Unknown recipe: ${name}. Type \`cook\` to see recipes.`;
      return startRecipeAction(p, recipe, 'cooking', 'cook');
    }
  });

  // ── Smithing (tick-based) ────────────────────────────────────────────────────
  commands.register('smelt', { help: 'Smelt ore into bars: smelt [bar]', category: 'Skills',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase();
      if (!name) {
        const available = recipes.forSkill('smithing').filter(r => r.station === 'furnace' && getLevel(p, 'smithing') >= r.level);
        return 'Smelting recipes:\n' + available.map(r => `  ${r.name} (lvl ${r.level}, ${r.xp} XP, ${r.ticks}t)`).join('\n');
      }
      const recipe = recipes.forSkill('smithing').find(r => r.station === 'furnace' && r.name.toLowerCase().includes(name));
      if (!recipe) return `Unknown smelting recipe: ${name}. Type \`smelt\` to see recipes.`;
      return startRecipeAction(p, recipe, 'smithing', 'smelt');
    }
  });

  commands.register('smith', { help: 'Smith bars into items: smith [item]', category: 'Skills',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase();
      if (!name) {
        const available = recipes.forSkill('smithing').filter(r => r.station === 'anvil' && getLevel(p, 'smithing') >= r.level);
        return 'Smithing recipes:\n' + available.map(r => `  ${r.name} (lvl ${r.level}, ${r.xp} XP, ${r.ticks}t)`).join('\n');
      }
      const recipe = recipes.forSkill('smithing').find(r => r.station === 'anvil' && r.name.toLowerCase().includes(name));
      if (!recipe) return `Unknown smithing recipe: ${name}. Type \`smith\` to see recipes.`;
      return startRecipeAction(p, recipe, 'smithing', 'smith', () => !invCount(p, 570) ? 'You need a hammer.' : null);
    }
  });

  // ── Crafting (tick-based) ────────────────────────────────────────────────────
  commands.register('craft', { help: 'Craft items: craft [item]', category: 'Skills',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase();
      if (!name) {
        const available = recipes.forSkill('crafting').filter(r => getLevel(p, 'crafting') >= r.level);
        return 'Crafting recipes:\n' + available.map(r => `  ${r.name} (lvl ${r.level}, ${r.xp} XP, ${r.ticks}t)`).join('\n');
      }
      const recipe = recipes.forSkill('crafting').find(r => r.name.toLowerCase().includes(name));
      if (!recipe) return `Unknown crafting recipe: ${name}. Type \`craft\` to see recipes.`;
      return startRecipeAction(p, recipe, 'crafting', 'craft');
    }
  });

  // ── Fletching (tick-based) ──────────────────────────────────────────────────
  commands.register('fletch', { help: 'Fletch items: fletch [item]', category: 'Skills',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase();
      if (!name) {
        const available = recipes.forSkill('fletching').filter(r => getLevel(p, 'fletching') >= r.level);
        return 'Fletching recipes:\n' + available.map(r => `  ${r.name} (lvl ${r.level}, ${r.xp} XP, ${r.ticks}t)`).join('\n');
      }
      const recipe = recipes.forSkill('fletching').find(r => r.name.toLowerCase().includes(name));
      if (!recipe) return `Unknown fletching recipe: ${name}. Type \`fletch\` to see recipes.`;
      return startRecipeAction(p, recipe, 'fletching', 'fletch');
    }
  });

  // ── Herblore (tick-based) ──────────────────────────────────────────────────
  commands.register('clean', { help: 'Clean a grimy herb: clean [herb]', category: 'Skills',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase();
      const recipe = recipes.forSkill('herblore').find(r => r.name.toLowerCase().includes(name) && r.id.startsWith('clean'));
      if (!recipe) return 'Usage: clean [herb name]. E.g., clean guam';
      return startRecipeAction(p, recipe, 'herblore', 'clean');
    }
  });

  commands.register('mix', { help: 'Mix a potion: mix [potion]', category: 'Skills',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase();
      if (!name) {
        const available = recipes.forSkill('herblore').filter(r => r.id.startsWith('mix') && getLevel(p, 'herblore') >= r.level);
        return 'Potion recipes:\n' + available.map(r => `  ${r.name} (lvl ${r.level}, ${r.xp} XP, ${r.ticks}t)`).join('\n');
      }
      const recipe = recipes.forSkill('herblore').find(r => r.id.startsWith('mix') && r.name.toLowerCase().includes(name));
      if (!recipe) return `Unknown potion: ${name}. Type \`mix\` to see recipes.`;
      return startRecipeAction(p, recipe, 'herblore', 'mix');
    }
  });

  // ── Firemaking (tick-based) ─────────────────────────────────────────────────
  commands.register('light', { help: 'Light logs: light [logs]', aliases: ['burn'], category: 'Skills',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase() || 'logs';
      const recipe = recipes.forSkill('firemaking').find(r => r.name.toLowerCase().includes(name));
      if (!recipe) return `Unknown: ${name}. Type \`light\` with: logs, oak, willow, maple, yew, magic`;
      return startRecipeAction(p, recipe, 'firemaking', 'light', () => !invCount(p, 573) ? 'You need a tinderbox.' : null);
    }
  });

  // ── High Alchemy ────────────────────────────────────────────────────────────
  commands.register('alch', { help: 'High alchemy: alch [item]', aliases: ['highalch'], category: 'Skills',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase();
      const slot = p.inventory.findIndex(s => s && s.name.toLowerCase() === name);
      if (slot < 0) return `You don't have "${name}".`;
      if (getLevel(p, 'magic') < 55) return 'You need Magic level 55.';
      if (invCount(p, 278) < 1) return 'You need a nature rune.';
      if (invCount(p, 273) < 5) return 'You need 5 fire runes.';
      const item = p.inventory[slot];
      const def = items.get(item.id) || items.find(item.name);
      const value = def ? def.highAlch : Math.floor((def?.value || 1) * 0.6);
      p.inventory[slot] = item.count > 1 ? { ...item, count: item.count - 1 } : null;
      invRemove(p, 278, 1); // nature rune
      invRemove(p, 273, 5); // fire runes
      invAdd(p, 101, 'Coins', value, true);
      const lvl = addXp(p, 'magic', 65);
      let msg = `You alch the ${item.name} for ${value} coins. +65 Magic XP.`;
      if (lvl) msg += ` Magic level: ${lvl}!`;
      return msg;
    }
  });

  // ── Shops ───────────────────────────────────────────────────────────────────
  commands.register('shop', { help: 'Browse a shop: shop [name] or shop', category: 'Economy',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase();
      let shop;
      if (name) {
        shop = shops.findByNpc(name) || shops.getShop(name);
      } else {
        // Find nearby shop NPC
        const nearby = npcs.getNpcsNear(p.x, p.y, 5, p.layer);
        for (const npc of nearby) {
          shop = shops.findByNpc(npc.name);
          if (shop) break;
        }
      }
      if (!shop) return 'No shop found. Try: shop [shopkeeper name]';
      let out = `── ${shop.name} ──\n`;
      shop.stock.forEach((s, i) => {
        const price = shops.buyPrice(shop, i);
        out += `  [${i}] ${s.name} — ${price} coins (stock: ${s.current})\n`;
      });
      out += `\nType \`buy [number] [amount]\` or \`sell [item]\``;
      p._currentShop = shop.id;
      return out;
    }
  });

  commands.register('buy', { help: 'Buy from shop: buy [slot] [amount]', category: 'Economy',
    fn: (p, args) => {
      if (!p._currentShop) return 'Open a shop first with `shop`.';
      const shop = shops.getShop(p._currentShop);
      if (!shop) return 'Shop not found.';
      const slot = parseInt(args[0]);
      const count = parseInt(args[1]) || 1;
      if (isNaN(slot)) return 'Usage: buy [slot number] [amount]';
      const result = shops.buy(shop, slot, count);
      if (!result) return 'Out of stock or invalid slot.';
      if (invCount(p, 101) < result.price) return `You need ${result.price} coins. You have ${invCount(p, 101)}.`;
      invRemove(p, 101, result.price);
      const itemDef = items.get(result.itemId);
      invAdd(p, result.itemId, result.name, result.count, itemDef?.stackable);
      return `Bought ${result.count}x ${result.name} for ${result.price} coins.`;
    }
  });

  commands.register('sell', { help: 'Sell to shop: sell [item]', category: 'Economy',
    fn: (p, args) => {
      if (!p._currentShop) return 'Open a shop first with `shop`.';
      const shop = shops.getShop(p._currentShop);
      if (!shop) return 'Shop not found.';
      const name = args.join(' ').toLowerCase();
      const slot = p.inventory.findIndex(s => s && s.name.toLowerCase() === name);
      if (slot < 0) return `You don't have "${name}".`;
      const item = p.inventory[slot];
      const def = items.get(item.id) || items.find(item.name);
      const value = def ? def.value : 1;
      const price = shops.sell(shop, item.id, item.name, 1, value);
      p.inventory[slot] = item.count > 1 ? { ...item, count: item.count - 1 } : null;
      invAdd(p, 101, 'Coins', price, true);
      return `Sold ${item.name} for ${price} coins.`;
    }
  });

  // ── Item lookup ─────────────────────────────────────────────────────────────
  commands.register('item', { help: 'Lookup item: item [name]', aliases: ['iteminfo'], category: 'Items',
    fn: (p, args) => {
      const name = args.join(' ');
      const def = items.find(name);
      if (!def) {
        const results = items.search(name);
        if (results.length === 0) return `No item found: "${name}"`;
        return `Did you mean:\n` + results.slice(0, 10).map(i => `  ${i.name} (id: ${i.id})`).join('\n');
      }
      let out = `── ${def.name} ──\n  ${def.examine}\n`;
      out += `  Value: ${def.value} | High Alch: ${def.highAlch} | Weight: ${def.weight}kg\n`;
      out += `  Tradeable: ${def.tradeable ? 'Yes' : 'No'} | Stackable: ${def.stackable ? 'Yes' : 'No'}\n`;
      if (def.equipSlot) out += `  Equip: ${def.equipSlot}${def.speed ? ` | Speed: ${def.speed}` : ''}\n`;
      if (Object.keys(def.stats).length) out += `  Stats: ${Object.entries(def.stats).map(([k,v]) => `${k}:${v}`).join(', ')}\n`;
      if (Object.keys(def.equipReqs).length) out += `  Requires: ${Object.entries(def.equipReqs).map(([k,v]) => `${k} ${v}`).join(', ')}\n`;
      return out;
    }
  });

  // ── Quests ──────────────────────────────────────────────────────────────────
  commands.register('quests', { help: 'List quests', aliases: ['questlist'], category: 'Quests',
    fn: (p) => {
      const all = quests.listAll();
      let out = `Quests (${all.length}):\n`;
      for (const q of all) {
        const status = quests.getStatus(p, q.id);
        const icon = status.complete ? '[✓]' : status.started ? '[~]' : '[ ]';
        out += `  ${icon} ${q.name} (${q.difficulty}, ${q.questPoints} QP)\n`;
      }
      out += `\nQuest Points: ${quests.getQuestPoints(p)}`;
      return out;
    }
  });

  commands.register('quest', { help: 'Quest info/progress: quest [name]', category: 'Quests',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase();
      const quest = [...quests.quests.values()].find(q => q.name.toLowerCase().includes(name));
      if (!quest) return `Unknown quest: "${name}". Type \`quests\` to see all.`;
      const status = quests.getStatus(p, quest.id);
      let out = `── ${quest.name} ── (${quest.difficulty})\n${quest.description}\n`;
      out += `QP: ${quest.questPoints} | Status: ${status.complete ? 'COMPLETE' : status.started ? `Step ${status.step + 1}/${quest.steps.length}` : 'Not started'}\n`;
      if (status.started && !status.complete) {
        out += `\nCurrent step: ${quest.steps[status.step].text}\n`;
      }
      if (Object.keys(quest.requirements).length) {
        if (quest.requirements.skills) out += `Requirements: ${Object.entries(quest.requirements.skills).map(([k,v]) => `${k} ${v}`).join(', ')}\n`;
      }
      return out;
    }
  });

  commands.register('startquest', { help: 'Start a quest: startquest [name]', category: 'Quests',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase();
      const quest = [...quests.quests.values()].find(q => q.name.toLowerCase().includes(name));
      if (!quest) return `Unknown quest: "${name}".`;
      const status = quests.getStatus(p, quest.id);
      if (status.complete) return 'Already completed.';
      if (status.started) return `Already started (step ${status.step + 1}).`;
      if (!quests.meetsRequirements(p, quest, getLevel)) return 'You don\'t meet the requirements.';
      quests.startQuest(p, quest.id);
      return `Quest started: ${quest.name}\n${quest.steps[0].text}`;
    }
  });

  commands.register('questadvance', { help: 'Advance quest step (debug)', category: 'Quests', admin: true,
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase();
      const quest = [...quests.quests.values()].find(q => q.name.toLowerCase().includes(name));
      if (!quest) return 'Unknown quest.';
      const result = quests.advanceStep(p, quest.id);
      if (result === 'complete') {
        let msg = `Quest complete: ${quest.name}! +${quest.questPoints} QP`;
        if (quest.rewards.xp) {
          for (const [skill, xp] of Object.entries(quest.rewards.xp)) {
            addXp(p, skill, xp);
            msg += `\n  +${xp} ${skill} XP`;
          }
        }
        return msg;
      }
      if (result !== null) return `Step ${result + 1}: ${quest.steps[result].text}`;
      return 'Cannot advance.';
    }
  });

  // ── Slayer ──────────────────────────────────────────────────────────────────
  commands.register('task', { help: 'Show current slayer task', aliases: ['slayertask'], category: 'Combat',
    fn: (p) => {
      if (!p.slayerTask) return 'No slayer task. Talk to a slayer master with `slayer [master]`.';
      return `Slayer task: Kill ${p.slayerTask.remaining}/${p.slayerTask.count} ${p.slayerTask.monster}s. Streak: ${p.slayerStreak || 0}. Points: ${p.slayerPoints || 0}.`;
    }
  });

  commands.register('slayer', { help: 'Get slayer task: slayer [master]', category: 'Combat',
    fn: (p, args) => {
      const masterName = args.join(' ').toLowerCase() || 'turael';
      const master = [...slayer.masters.values()].find(m => m.name.toLowerCase() === masterName);
      if (!master) return `Unknown master: ${masterName}. Masters: ${[...slayer.masters.values()].map(m => m.name).join(', ')}`;
      if (p.slayerTask && p.slayerTask.remaining > 0) return `You already have a task: ${p.slayerTask.remaining} ${p.slayerTask.monster}s remaining.`;
      const task = slayer.assignTask(p, master.id, getLevel);
      if (!task) return 'No suitable tasks available.';
      p.slayerTask = task;
      return `${master.name}: "Your task is to kill ${task.count} ${task.monster}s."`;
    }
  });

  // ── Friends ─────────────────────────────────────────────────────────────────
  commands.register('friends', { help: 'Show friends list', aliases: ['fl'], category: 'Social',
    fn: (p) => {
      if (!p.friends) p.friends = [];
      if (!p.friends.length) return 'Friends list is empty. Use `friend add [name]`.';
      let out = 'Friends:\n';
      for (const name of p.friends) {
        const online = playersByName.has(name.toLowerCase());
        out += `  ${online ? '●' : '○'} ${name} ${online ? '(online)' : '(offline)'}\n`;
      }
      return out;
    }
  });

  commands.register('friend', { help: 'Add/remove friend: friend add/remove [name]', category: 'Social',
    fn: (p, args) => {
      if (!p.friends) p.friends = [];
      const action = args[0]?.toLowerCase();
      const name = args.slice(1).join(' ');
      if (action === 'add' && name) {
        if (p.friends.includes(name)) return 'Already on friends list.';
        if (p.friends.length >= 400) return 'Friends list full (400).';
        p.friends.push(name);
        return `Added ${name} to friends list.`;
      }
      if (action === 'remove' && name) {
        const idx = p.friends.findIndex(f => f.toLowerCase() === name.toLowerCase());
        if (idx < 0) return 'Not on friends list.';
        p.friends.splice(idx, 1);
        return `Removed ${name} from friends list.`;
      }
      return 'Usage: friend add [name] / friend remove [name]';
    }
  });

  // ── Ignore ──────────────────────────────────────────────────────────────────
  commands.register('ignore', { help: 'Ignore a player: ignore [name]', category: 'Social',
    fn: (p, args) => {
      if (!p.ignoreList) p.ignoreList = [];
      const name = args.join(' ');
      if (!name) return `Ignore list: ${p.ignoreList.join(', ') || 'empty'}`;
      if (p.ignoreList.includes(name.toLowerCase())) return 'Already ignored.';
      p.ignoreList.push(name.toLowerCase());
      return `Ignoring ${name}.`;
    }
  });

  commands.register('unignore', { help: 'Unignore a player', category: 'Social',
    fn: (p, args) => {
      if (!p.ignoreList) p.ignoreList = [];
      const name = args.join(' ').toLowerCase();
      const idx = p.ignoreList.indexOf(name);
      if (idx < 0) return 'Not on ignore list.';
      p.ignoreList.splice(idx, 1);
      return `Unignored ${name}.`;
    }
  });

  // ── Trade ───────────────────────────────────────────────────────────────────
  commands.register('trade', { help: 'Trade with player: trade [name]', category: 'Economy',
    fn: (p, args) => {
      const name = args.join(' ');
      const target = findPlayer(name);
      if (!target) return `Player "${name}" not found.`;
      if (target === p) return "You can't trade with yourself.";
      // Simplified: just show both inventories
      let out = `── Trade with ${target.name} ──\n`;
      out += `Your inventory:\n`;
      p.inventory.filter(s => s).forEach((s, i) => { out += `  ${s.name}${s.count > 1 ? ` x${s.count}` : ''}\n`; });
      out += `\nTheir inventory:\n`;
      target.inventory.filter(s => s).forEach((s, i) => { out += `  ${s.name}${s.count > 1 ? ` x${s.count}` : ''}\n`; });
      out += `\nUse \`give [player] [item]\` to transfer items directly (trust trade).`;
      return out;
    }
  });

  commands.register('giveto', { help: 'Give item to player: giveto [player] [item]', category: 'Economy',
    fn: (p, args) => {
      if (args.length < 2) return 'Usage: giveto [player] [item name]';
      const targetName = args[0];
      const itemName = args.slice(1).join(' ').toLowerCase();
      const target = findPlayer(targetName);
      if (!target) return `Player "${targetName}" not found.`;
      const slot = p.inventory.findIndex(s => s && s.name.toLowerCase() === itemName);
      if (slot < 0) return `You don't have "${itemName}".`;
      if (invFreeSlots(target) < 1) return `${target.name}'s inventory is full.`;
      const item = p.inventory[slot];
      p.inventory[slot] = item.count > 1 ? { ...item, count: item.count - 1 } : null;
      invAdd(target, item.id, item.name, 1, items.get(item.id)?.stackable);
      // Notify target
      for (const [ws, pl] of players) {
        if (pl === target) { sendText(ws, `${p.name} gave you: ${item.name}`); break; }
      }
      return `Gave ${item.name} to ${target.name}.`;
    }
  });

  // ── Death system ────────────────────────────────────────────────────────────
  // Already handled in combatTick, but add respawn info
  commands.register('death', { help: 'Show death rules', category: 'General',
    fn: (p) => {
      return 'Death rules:\n  - You keep your 3 most valuable items.\n  - Other items appear at your gravestone for 15 minutes.\n  - Respawn at last home location.\n  - Protect Item prayer: keep 1 extra item.';
    }
  });

  // ── Hiscores ────────────────────────────────────────────────────────────────
  commands.register('hiscores', { help: 'Show skill rankings', aliases: ['hs', 'ranks'], category: 'General',
    fn: (p, args) => {
      const skill = args[0]?.toLowerCase() || 'total';
      // Collect all saved player data
      const fs = require('fs');
      const path = require('path');
      const playersDir = path.join(persistence.DATA_DIR, 'players');
      if (!fs.existsSync(playersDir)) return 'No hiscores data.';
      const allPlayers = [];
      // Include online players
      for (const pl of playersByName.values()) {
        allPlayers.push({ name: pl.name, skills: pl.skills });
      }
      if (skill === 'total') {
        allPlayers.sort((a, b) => {
          const ta = Object.values(b.skills).reduce((s, sk) => s + sk.level, 0);
          const tb = Object.values(a.skills).reduce((s, sk) => s + sk.level, 0);
          return ta - tb;
        });
        let out = '── Hiscores (Total Level) ──\n';
        allPlayers.slice(0, 20).forEach((pl, i) => {
          const total = Object.values(pl.skills).reduce((s, sk) => s + sk.level, 0);
          out += `  ${i + 1}. ${pl.name} — ${total}\n`;
        });
        return out;
      }
      if (!allPlayers[0]?.skills[skill]) return `Unknown skill: ${skill}`;
      allPlayers.sort((a, b) => (b.skills[skill]?.xp || 0) - (a.skills[skill]?.xp || 0));
      let out = `── Hiscores (${skill}) ──\n`;
      allPlayers.slice(0, 20).forEach((pl, i) => {
        out += `  ${i + 1}. ${pl.name} — Level ${pl.skills[skill]?.level || 1} (${(pl.skills[skill]?.xp || 0).toLocaleString()} XP)\n`;
      });
      return out;
    }
  });

  // ── Emotes ──────────────────────────────────────────────────────────────────
  const EMOTES = ['wave', 'bow', 'dance', 'clap', 'cry', 'laugh', 'think', 'shrug', 'yes', 'no',
    'angry', 'cheer', 'beckon', 'panic', 'sit', 'push-up', 'headbang', 'salute', 'stomp', 'flex',
    'spin', 'yawn', 'stretch', 'blow kiss', 'jig', 'goblin bow', 'goblin salute'];

  commands.register('emote', { help: 'Perform emote: emote [name]', category: 'Social',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase();
      if (!name) return 'Emotes: ' + EMOTES.join(', ');
      if (!EMOTES.includes(name)) return `Unknown emote. Available: ${EMOTES.join(', ')}`;
      broadcast({ t: 'emote', from: p.name, emote: name });
      return `You perform the ${name} emote.`;
    }
  });

  // ── World info ──────────────────────────────────────────────────────────────
  commands.register('world', { help: 'Show world info', category: 'General',
    fn: () => {
      return `World 1 — OpenScape\nPlayers: ${playersByName.size}\nTick: ${tick.getTick()}\nUptime: ${Math.floor(tick.getTick() * 0.6)}s`;
    }
  });

  // ── Recipes browser ─────────────────────────────────────────────────────────
  commands.register('recipes', { help: 'Browse recipes: recipes [skill]', category: 'Skills',
    fn: (p, args) => {
      const skill = args[0]?.toLowerCase();
      if (!skill) return 'Usage: recipes [cooking/smithing/crafting/fletching/herblore/firemaking]';
      const list = recipes.forSkill(skill);
      if (!list.length) return `No recipes for ${skill}.`;
      let out = `── ${skill} recipes ──\n`;
      for (const r of list) {
        const canMake = getLevel(p, skill) >= r.level;
        const inputs = r.inputs.map(i => `${i.count}x ${items.get(i.id)?.name || '?'}`).join(' + ');
        const outputs = r.outputs.length ? r.outputs.map(o => `${o.count}x ${items.get(o.id)?.name || '?'}`).join(', ') : '(none)';
        out += `  ${canMake ? '✓' : '✕'} ${r.name} — ${inputs} → ${outputs} (lvl ${r.level}, ${r.xp} XP)\n`;
      }
      return out;
    }
  });

  // ── Rest (run energy recovery) ──────────────────────────────────────────────
  commands.register('rest', { help: 'Rest to recover run energy faster', category: 'Navigation',
    fn: (p) => {
      p.runEnergy = Math.min(10000, p.runEnergy + 2000);
      return `You rest for a moment. Energy: ${(p.runEnergy / 100).toFixed(0)}%`;
    }
  });

  // ── Home teleport ───────────────────────────────────────────────────────────
  commands.register('home', { help: 'Teleport home (to spawn)', category: 'Navigation',
    fn: (p) => {
      p.x = 100; p.y = 100; p.layer = 0; p.path = [];
      return 'You teleport home to Spawn Island.';
    }
  });

  // ── Agility ────────────────────────────────────────────────────────────────
  commands.register('cross', { help: 'Cross an agility obstacle: cross [obstacle]', aliases: ['climb', 'jump', 'balance'], category: 'Skills',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase();
      if (!name) return 'Usage: cross [obstacle]. Look around for agility obstacles.';

      let foundCourse = null, foundObstacle = null, foundIdx = -1;
      for (const [courseId, course] of Object.entries(AGILITY_COURSES)) {
        for (let i = 0; i < course.obstacles.length; i++) {
          const obs = course.obstacles[i];
          // Match by obstacle name or definition id (e.g. "wall", "low wall", "agility_wall")
          const obsLower = obs.name.toLowerCase();
          const defLower = (obs.defId || '').toLowerCase().replace(/_/g, ' ');
          if (obsLower.includes(name) || obsLower === name || defLower.includes(name) || name.includes(obsLower)) {
            const dist = Math.max(Math.abs(p.x - obs.x), Math.abs(p.y - obs.y));
            if (dist <= 10) { foundCourse = { id: courseId, ...course }; foundObstacle = obs; foundIdx = i; break; }
          }
        }
        if (foundObstacle) break;
      }

      if (!foundObstacle) return `No obstacle called "${name}" nearby.`;
      if (getLevel(p, 'agility') < foundCourse.levelReq) return `You need Agility level ${foundCourse.levelReq}.`;
      if (p.busy) actions.cancel(p);

      actions.start(p, {
        type: 'agility',
        ticks: 3,
        repeat: false,
        data: { player: p, course: foundCourse, obstacle: foundObstacle, obstacleIdx: foundIdx },
        onComplete: (data) => {
          const pl = data.player;
          const lvl = addXp(pl, 'agility', data.obstacle.xp);
          if (!pl.agilityLap || pl.agilityLap.courseId !== data.course.id) {
            pl.agilityLap = { courseId: data.course.id, obstaclesDone: new Set() };
          }
          pl.agilityLap.obstaclesDone.add(data.obstacleIdx);
          let msg = `You cross the ${data.obstacle.name}. +${data.obstacle.xp} Agility XP.`;
          if (lvl) msg += ` Agility level: ${lvl}!`;
          if (pl.agilityLap.obstaclesDone.size >= data.course.obstacles.length) {
            const lapLvl = addXp(pl, 'agility', data.course.lapBonus);
            msg += `\nLap complete! +${data.course.lapBonus} bonus Agility XP.`;
            if (lapLvl) msg += ` Agility level: ${lapLvl}!`;
            pl.agilityLap = null;
          } else {
            msg += ` (${pl.agilityLap.obstaclesDone.size}/${data.course.obstacles.length} obstacles)`;
          }
          return msg;
        },
      });
      return `You attempt to cross the ${foundObstacle.name}...`;
    }
  });

  // ── Thieving ───────────────────────────────────────────────────────────────
  commands.register('pickpocket', { help: 'Pickpocket an NPC: pickpocket [npc]', aliases: ['steal'], category: 'Skills',
    fn: (p, args) => {
      const name = args.join(' ');
      if (!name) return 'Usage: pickpocket [npc name]';
      if (p.stunTicks > 0) return `You are stunned! (${p.stunTicks} ticks remaining)`;

      const npc = npcs.findNpcByName(name, p.x, p.y, 10, p.layer);
      if (!npc) return `No "${name}" nearby. Type \`nearby\` to see who's around.`;

      const npcDef = npcs.npcDefs.get(npc.defId);
      if (!npcDef || !npcDef.thieving) return `You can't pickpocket the ${npc.name}.`;

      const thieving = npcDef.thieving;
      if (getLevel(p, 'thieving') < thieving.level) return `You need Thieving level ${thieving.level}.`;

      const levelDiff = getLevel(p, 'thieving') - thieving.level;
      const successChance = Math.min(0.95, 0.5 + levelDiff * 0.02);

      if (Math.random() < successChance) {
        const loot = thieving.loot[Math.floor(Math.random() * thieving.loot.length)];
        const count = loot.min + Math.floor(Math.random() * (loot.max - loot.min + 1));
        const itemDef = items.get(loot.id);
        invAdd(p, loot.id, loot.name, count, itemDef?.stackable);
        const lvl = addXp(p, 'thieving', thieving.xp);
        updateWeight(p);
        let msg = `You pick the ${npc.name}'s pocket. Got: ${loot.name} x${count}. +${thieving.xp} Thieving XP.`;
        if (lvl) msg += ` Thieving level: ${lvl}!`;
        return msg;
      } else {
        const dmg = 1 + Math.floor(Math.random() * (thieving.stunDamage || 2));
        p.hp = Math.max(0, p.hp - dmg);
        p.stunTicks = 4;
        let msg = `You fail to pickpocket the ${npc.name}! They hit you for ${dmg}. HP: ${p.hp}/${p.maxHp}. Stunned for 4 ticks!`;
        if (p.hp <= 0) {
          msg += '\nOh dear, you are dead!';
          p.hp = p.maxHp; p.x = 100; p.y = 100; p.layer = 0; p.path = []; p.stunTicks = 0;
        }
        return msg;
      }
    }
  });

  // ── Potion Drinking ────────────────────────────────────────────────────────
  commands.register('drink', { help: 'Drink a potion: drink [potion]', category: 'Items',
    fn: (p, args) => {
      const name = args.join(' ').toLowerCase();
      if (!name) return 'Usage: drink [potion name]';
      const slot = p.inventory.findIndex(s => s && s.name.toLowerCase().includes(name));
      if (slot < 0) return `You don't have "${name}".`;
      const item = p.inventory[slot];
      const def = items.get(item.id);
      if (!def || def.category !== 'potion') return `You can't drink ${item.name}.`;

      p.inventory[slot] = item.count > 1 ? { ...item, count: item.count - 1 } : null;
      if (!p.boosts) p.boosts = {};
      const potionName = item.name.toLowerCase();
      let msg = `You drink the ${item.name}.`;

      if (potionName.includes('super attack')) {
        const boost = 5 + Math.floor(getLevel(p, 'attack') * 0.15);
        p.boosts.attack = { amount: boost, ticksLeft: 90 };
        msg += ` Attack boosted by +${boost} for 90 ticks.`;
      } else if (potionName.includes('super strength')) {
        const boost = 5 + Math.floor(getLevel(p, 'strength') * 0.15);
        p.boosts.strength = { amount: boost, ticksLeft: 90 };
        msg += ` Strength boosted by +${boost} for 90 ticks.`;
      } else if (potionName.includes('attack')) {
        const boost = 3 + Math.floor(getLevel(p, 'attack') * 0.1);
        p.boosts.attack = { amount: boost, ticksLeft: 90 };
        msg += ` Attack boosted by +${boost} for 90 ticks.`;
      } else if (potionName.includes('strength')) {
        const boost = 3 + Math.floor(getLevel(p, 'strength') * 0.1);
        p.boosts.strength = { amount: boost, ticksLeft: 90 };
        msg += ` Strength boosted by +${boost} for 90 ticks.`;
      } else if (potionName.includes('defence')) {
        const boost = 3 + Math.floor(getLevel(p, 'defence') * 0.1);
        p.boosts.defence = { amount: boost, ticksLeft: 90 };
        msg += ` Defence boosted by +${boost} for 90 ticks.`;
      } else if (potionName.includes('prayer')) {
        const restore = Math.floor(7 + getLevel(p, 'prayer') / 4);
        p.prayerPoints = Math.min(getLevel(p, 'prayer'), p.prayerPoints + restore);
        msg += ` Prayer restored by ${restore}. Prayer: ${p.prayerPoints}/${getLevel(p, 'prayer')}.`;
      } else if (potionName.includes('restore')) {
        if (p.boosts) for (const [sk, b] of Object.entries(p.boosts)) { if (b.amount < 0) delete p.boosts[sk]; }
        msg += ' Your stats have been restored.';
      } else if (potionName.includes('antipoison')) {
        msg += ' You have been cured of poison.';
      } else {
        msg += ' Nothing interesting happens.';
      }

      invAdd(p, 325, 'Vial', 1);
      updateWeight(p);
      return msg;
    }
  });

  // ── Weight ─────────────────────────────────────────────────────────────────
  commands.register('weight', { help: 'Show your carry weight', category: 'General',
    fn: (p) => {
      updateWeight(p);
      return `Weight: ${p.weight.toFixed(1)} kg`;
    }
  });

  // ── Map Command ───────────────────────────────────────────────────────────
  commands.register('map', { help: 'Show ASCII map of surroundings (15x15)', category: 'Navigation',
    fn: (p) => {
      const T = tiles.T;
      const RADIUS = 7; // 15x15 grid = radius 7
      const TILE_CHARS = {
        [T.EMPTY]: 'X', [T.GRASS]: '.', [T.WATER]: '~', [T.TREE]: 'T',
        [T.PATH]: '=', [T.ROCK]: '#', [T.SAND]: 'S', [T.WALL]: '#',
        [T.FLOOR]: '.', [T.DOOR]: 'D', [T.BRIDGE]: '=', [T.FISH_SPOT]: '~',
        [T.FLOWER]: ',', [T.BUSH]: 'b', [T.DARK_GRASS]: '.', [T.SNOW]: '*',
        [T.LAVA]: '!', [T.SWAMP]: '%',
      };

      // Build sets of NPC and object positions for quick lookup
      const npcPositions = new Map();
      const nearNpcs = npcs.getNpcsNear(p.x, p.y, RADIUS, p.layer);
      for (const n of nearNpcs) npcPositions.set(`${n.x},${n.y}`, n);

      const objPositions = new Map();
      const nearObjs = objects.getObjectsNear(p.x, p.y, RADIUS, p.layer);
      for (const o of nearObjs) if (!o.depleted) objPositions.set(`${o.x},${o.y}`, o);

      const playerPositions = new Map();
      for (const [, pl] of players) {
        if (pl !== p && pl.connected && pl.layer === p.layer &&
            Math.abs(pl.x - p.x) <= RADIUS && Math.abs(pl.y - p.y) <= RADIUS) {
          playerPositions.set(`${pl.x},${pl.y}`, pl);
        }
      }

      let map = '    ';
      // Column headers
      for (let dx = -RADIUS; dx <= RADIUS; dx++) {
        map += (dx === 0) ? 'v' : ' ';
      }
      map += '\n';

      for (let dy = -RADIUS; dy <= RADIUS; dy++) {
        const worldY = p.y + dy;
        map += (dy === 0) ? ' > ' : '   ';
        map += ' ';
        for (let dx = -RADIUS; dx <= RADIUS; dx++) {
          const worldX = p.x + dx;
          const key = `${worldX},${worldY}`;

          if (dx === 0 && dy === 0) {
            map += '@'; // Player
          } else if (playerPositions.has(key)) {
            map += 'P';
          } else if (npcPositions.has(key)) {
            map += '!';
          } else if (objPositions.has(key)) {
            map += '?';
          } else {
            const tile = tiles.tileAt(worldX, worldY, p.layer);
            map += TILE_CHARS[tile] || 'X';
          }
        }
        map += '\n';
      }

      map += '\nLegend: @ You  ! NPC  ? Object  P Player  # Wall/Rock  T Tree';
      map += '\n        ~ Water  . Grass/Floor  = Path  S Sand  D Door  X Unwalkable';
      const area = tiles.getArea(p.x, p.y, p.layer);
      if (area) map += `\nArea: ${area.name}`;
      return map;
    }
  });

  // ── Nearby Command ────────────────────────────────────────────────────────
  commands.register('nearby', { help: 'List everything within 10 tiles', category: 'Navigation',
    fn: (p) => {
      const RANGE = 10;
      let out = `=== Nearby (within ${RANGE} tiles) ===`;

      // NPCs
      const nearNpcs = npcs.getNpcsNear(p.x, p.y, RANGE, p.layer);
      if (nearNpcs.length) {
        out += '\n\n-- NPCs --';
        for (const n of nearNpcs) {
          const dist = Math.max(Math.abs(n.x - p.x), Math.abs(n.y - p.y));
          const dir = getDirection(p.x, p.y, n.x, n.y);
          out += `\n  ${n.name} (lvl ${n.combat}) - ${dist} tiles ${dir} (${n.x},${n.y})`;
        }
      }

      // Objects
      const nearObjs = objects.getObjectsNear(p.x, p.y, RANGE, p.layer);
      const activeObjs = nearObjs.filter(o => !o.depleted);
      if (activeObjs.length) {
        out += '\n\n-- Objects --';
        for (const o of activeObjs) {
          const dist = Math.max(Math.abs(o.x - p.x), Math.abs(o.y - p.y));
          const dir = getDirection(p.x, p.y, o.x, o.y);
          out += `\n  ${o.name} - ${dist} tiles ${dir} (${o.x},${o.y})`;
        }
      }

      // Ground items
      const nearItems = groundItems.filter(i =>
        Math.abs(i.x - p.x) <= RANGE && Math.abs(i.y - p.y) <= RANGE && i.layer === p.layer
      );
      if (nearItems.length) {
        out += '\n\n-- Items --';
        for (const i of nearItems) {
          const dist = Math.max(Math.abs(i.x - p.x), Math.abs(i.y - p.y));
          const dir = getDirection(p.x, p.y, i.x, i.y);
          out += `\n  ${i.name} x${i.count} - ${dist} tiles ${dir} (${i.x},${i.y})`;
        }
      }

      // Players
      const nearPlayers = [];
      for (const [, pl] of players) {
        if (pl !== p && pl.connected && pl.layer === p.layer &&
            Math.abs(pl.x - p.x) <= RANGE && Math.abs(pl.y - p.y) <= RANGE) {
          nearPlayers.push(pl);
        }
      }
      if (nearPlayers.length) {
        out += '\n\n-- Players --';
        for (const pl of nearPlayers) {
          const dist = Math.max(Math.abs(pl.x - p.x), Math.abs(pl.y - p.y));
          const dir = getDirection(p.x, p.y, pl.x, pl.y);
          out += `\n  ${pl.name} (combat ${combatLevel(pl)}) - ${dist} tiles ${dir}`;
        }
      }

      // Exits / paths to other areas
      const currentArea = tiles.getArea(p.x, p.y, p.layer);
      const areasSeen = new Set();
      if (currentArea) areasSeen.add(currentArea.id);
      const exits = [];
      for (let dx = -RANGE; dx <= RANGE; dx++) {
        for (let dy = -RANGE; dy <= RANGE; dy++) {
          const wx = p.x + dx, wy = p.y + dy;
          const a = tiles.getArea(wx, wy, p.layer);
          if (a && !areasSeen.has(a.id)) {
            areasSeen.add(a.id);
            const dist = Math.max(Math.abs(dx), Math.abs(dy));
            const dir = getDirection(p.x, p.y, wx, wy);
            exits.push({ name: a.name, dist, dir });
          }
        }
      }
      if (exits.length) {
        out += '\n\n-- Exits / Nearby Areas --';
        exits.sort((a, b) => a.dist - b.dist);
        for (const e of exits) {
          out += `\n  ${e.name} - ${e.dist} tiles ${e.dir}`;
        }
      }

      return out;
    }
  });

  // Direction helper for nearby/map
  function getDirection(fromX, fromY, toX, toY) {
    const dx = toX - fromX, dy = toY - fromY;
    if (dx === 0 && dy === 0) return 'here';
    let dir = '';
    if (dy < 0) dir += 'N';
    if (dy > 0) dir += 'S';
    if (dx < 0) dir += 'W';
    if (dx > 0) dir += 'E';
    return dir;
  }

  // ── Status Command ────────────────────────────────────────────────────────
  commands.register('status', { help: 'Show detailed player status', category: 'General',
    fn: (p) => {
      updateWeight(p);
      const cb = combatLevel(p);
      let out = '=== Status ===';
      out += `\nHP: ${p.hp}/${p.maxHp}`;
      out += `\nPrayer: ${p.prayerPoints}/${getLevel(p, 'prayer')}`;
      out += `\nRun Energy: ${(p.runEnergy / 100).toFixed(0)}%${p.running ? ' (running)' : ''}`;
      out += `\nWeight: ${p.weight.toFixed(1)} kg`;
      out += `\nCombat Level: ${cb}`;
      out += `\nSpecial Attack: ${(p.specialEnergy / 10).toFixed(0)}%`;

      // Current action
      if (p.busy && p.busyAction) {
        out += `\nCurrent Action: ${p.busyAction}`;
      } else if (p.combatTarget) {
        const npc = npcs.getNpc(p.combatTarget);
        out += `\nCurrent Action: Fighting ${npc ? npc.name : 'unknown'}`;
      } else if (p.pvpTarget) {
        out += `\nCurrent Action: PvP combat`;
      } else if (p.path.length > 0) {
        out += `\nCurrent Action: Walking (${p.path.length} steps remaining)`;
      }

      // Active boosts
      if (p.boosts && Object.keys(p.boosts).length > 0) {
        out += '\nActive Boosts:';
        for (const [skill, boost] of Object.entries(p.boosts)) {
          if (boost.ticksLeft > 0) {
            out += `\n  ${skill}: +${boost.amount} (${boost.ticksLeft} ticks left)`;
          }
        }
      }

      // Active prayers
      if (p.activePrayers && p.activePrayers.size > 0) {
        out += `\nActive Prayers: ${[...p.activePrayers].join(', ')}`;
      }

      // Slayer task
      if (p.slayerTask) {
        out += `\nSlayer Task: ${p.slayerTask.monster} (${p.slayerTask.remaining} remaining)`;
      }

      // Wilderness level
      if (p.y <= 55) {
        const wildyLevel = 55 - p.y;
        out += `\nWilderness Level: ${wildyLevel} (PvP enabled!)`;
      }

      // Skull timer
      if (p.skull > 0) {
        out += `\nSkull Timer: ${p.skull} ticks remaining`;
      }

      // Stun
      if (p.stunTicks > 0) {
        out += `\nStunned: ${p.stunTicks} ticks remaining`;
      }

      // Position and area
      out += `\nPosition: (${p.x}, ${p.y}) Layer ${p.layer}`;
      const area = tiles.getArea(p.x, p.y, p.layer);
      if (area) out += `\nArea: ${area.name}`;

      return out;
    }
  });
};
