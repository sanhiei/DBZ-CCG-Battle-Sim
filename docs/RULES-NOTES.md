# Engine-relevant rules (distilled from the CRD)

Source of truth: [`CRD.txt`](CRD.txt) (Updated 8/19/2014). Line references below point into that file. **The CRD overrides the printed rulebook and card rules text overrides the CRD's general rules (the "Golden Rule").** This file is a working summary for building `@dbz/engine`; when in doubt, re-read the CRD.

## Win conditions (CRD §3, ~L147)
1. **Survival Victory** — opponent must take a life-card of damage but has no life cards left to lose (Dragon Ball Loop: if you'd take life-card damage and only have Dragon Balls left, you lose).
2. **Dragon Ball Victory** — gather the required Dragon Balls (set-dependent, e.g. 7).
3. **Most Powerful Personality Victory (MPPP)** — endgame/timeout comparison of power.

## Pre-game setup (CRD ~L186)
1. Both players reveal MP personality cards face-up in numerical order, lowest level on top. Rogue MPs declare hero/villain.
2. Declare Tokui-Waza + play the Mastery card of that style, if any.
3. **Both players set their scouters at 5 power stages above the 0 power stage** on their starting (level 1) MP.
4. **D-Power Rule** (go-first): if one MP at "5 above 0" is in the **D bracket or higher** of the PAT and the other is not, the **lower-bracket player goes first**. If one is D-bracket and the other has **Z** power stages, both start at 5-above-0 and first player is random.
5. Shuffle Life Decks, offer cut.
6. Swap Sensei Deck ↔ Life Deck cards.
7. Begin.

## Turn = 7 steps (Sequence of Play, CRD ~L214)
1. **Draw Step**
2. **Non-Combat Step** — play Allies, Drills, Non-Combat cards, Locations/Battlegrounds (playing a Location/Battleground forces you to skip the Combat Step).
3. **Power-Up Step** — MP and Allies gain power stages by their **PUR**. Allies always power up by **exactly 1** regardless of PUR.
4. **Declare Step** — declare combat.
5. **Combat Step** — Attack Phases alternate; ends when both players **pass consecutively**.
6. **Discard Step**
7. **Rejuvenation Step**

### Prepare Phase (start of Combat, defender, CRD ~L267)
1. Defender uses any "When entering Combat" effects (each once).
2. Defender draws 3 cards into hand.

### Attack Phase — 16-step resolution sequence (CRD ~L316). This is the combat engine core:
1. Attacker plays a Physical/Energy/Combat card, uses a Non-Combat card / personality power, or **passes**.
2. Attacker pays costs; announces any **Empower** boost.
3. Resolve **secondary effects** (not "if successful", not in the same sentence as the attack).
4. If an Ally can take over Combat, defender announces who is **in Control of Combat** for this attack.
5. Defender plays a card / uses Non-Combat / personality power to defend.
6. Resolve defender's secondary effects.
7. If not stopped, defender activates **Defense Shields**.
8. If still not stopped, the attack is **successful** (successful even if it deals 0 damage).
9. Determine **Base Damage**: physical → PAT lookup (unless stated on card); energy → stated amount, else **4 life cards**.
10. Apply modifiers (attack text, Drills, powers) to Base Damage.
11. If the Ally in control can capture a Dragon Ball (Personality Capture Rule), decide damage vs. capture.
12. Deal **power stages** of damage.
13. Deal **life cards** of damage; defender may use **Endurance** here.
14. If attack dealt **5+ life cards**, attacker may capture an opponent's Dragon Ball.
15. Resolve attacker's **"If successful"** effects (attacker orders multiples).
16. Discard the attack card unless it says otherwise.

**Attacker options each Attack Phase** (CRD ~L286): play an attack from hand; use a card in play that can attack; use a Non-Combat card (then discard); play a card + use + discard; use a personality power; perform a **Final Physical Attack**; pass.

**Defender options** (CRD ~L304): play a **starburst** card from hand; use an in-play Non-Combat with a starburst; use an MP/Ally effect that stops the attack or prevents damage; **take the damage**.

## Attacks (CRD ~L449)
- **Physical attack** — deals **power stages** of damage; Base Damage from the **PAT** unless the card states an exact amount.
- **Energy attack** — **costs 2 power stages** to perform; deals **4 life cards** of damage (flip from top of Life Deck to discard) unless the card says otherwise.
- **Final Physical Attack** — physical attack for **PAT** power stages, cost = discard any 1 card from hand; afterward you must pass all remaining Attack Phases and cannot defend.

## Physical Attack Table (PAT) (CRD ~L426, glossary L2548)
- PAT = "the number found when you compare the power **ratings** of the two personalities" = Base Damage for physical attacks. Also referenced by a **PAT symbol** in card text.
- The PAT is the grid **printed on a scouter**: rows/cols are power ratings, cells are damage, grouped into lettered **brackets** (…, D, …, up to **Z**).
- **Z power stages**: King Kai, Grand Kai, Supreme Kai, Supreme West Kai, Mr. Popo use **Z** instead of numbers. When comparing on the PAT, if either has Z, **the result is always 2** (you still "use" the table).
- **Bubbles** (Tuff Enuff): physical attack with a "Tuff Enuff only" card → base damage always **3** (incl. vs Z); does not affect Final Physical Attacks.

> **Data gap:** the numeric PAT grid + power-level chart are embedded **images** in the CRD (Sections 10 & 12), not text. Engine models the PAT as a data table (`@dbz/engine/src/pat.ts`) — reconstruct the exact grid/brackets from a scouter scan and fill it in. Until then a placeholder table + the Z/Bubbles/D-bracket rules are implemented.

## Power system
- **Power stages** — spaces on a personality card holding power ratings (to the right of the art).
- **Power rating** — the numeric value in the personality's *current* power stage.
- **PUR (Power-Up Rating)** — number on the left of the card; how many stages the personality gains in the Power-Up Step (Allies: always +1).
- A **scouter** tracks the current stage; "5 power stages above 0" is the start.

## Anger (CRD ~L519)
- **5+ anger → the MP immediately advances a personality level** (if possible); **anger resets to 0** on advancement (and on losing a level).
- **Anger from a single effect never carries over** (no double-counting one source).
- Advancing/losing a level: re-enables that turn's personality power (can use again), and **discards that player's Drills**.

## Personalities (CRD §4, ~L481)
- MP = **3+ consecutive personality cards starting at level 1** (some go to level 5). Always starts at level 1.
- **Personality Power** — usable only during the **Combat Step**, **once per turn** (unless card says otherwise), refreshed when the personality advances/loses a level. Can't use MP power while an Ally controls Combat, and vice-versa.
- **Constant Combat Power** — continuous while that personality controls Combat.

## Allies (CRD ~L536)
- Ally = a Personality card that assists the MP; **played during the Non-Combat Step** by the active player.
- **Enter at 3 power stages above 0.**
- **Power up by exactly 1** each Power-Up Step (ignore PUR).
- Level constraint on entry: Ally's personality level ≤ MP's current level (MP L1 → only L1 allies, etc.). Also (§2 L113) Allies must be **at least 2 levels lower than your MP's highest personality level** for deckbuilding.
- **Take over Combat**: if MP is at **0 or 1 stage above 0** (its bottom 2 stages), an Ally may take Control of Combat; it then attacks / uses powers and **its power rating is used on the PAT**. Stays in control until MP leaves its bottom-2 or another personality takes over. Allies **cannot** use "When Entering Combat" effects.
- **Redirect damage**: when an opponent's attack becomes successful, you may **redirect power-stage damage** to a personality **not** in control of Combat (opponent still uses the controller's power rating for the PAT).
- **Personality Capture Rule** — some Allies may capture an opponent's in-play Dragon Ball instead of dealing life-card damage on a successful attack that would deal 1+ life cards. Capturing Allies: **Bulma, Chi-Chi, Frieza, Garlic Jr., Guldo, Krillin, Master Roshi, Saibaimen, Videl, Tien, Yamcha**.

## Deck building (CRD §2)
- **50–85 cards** (up to **90** if you declare a Namekian Tokui-Waza).
- Limit 1 each: Mastery, each MP level, Sensei card, each Dragon Ball. All Dragon Balls same set ("Alt." mixes with same set).
- Ally personality: multiple allies allowed, but **each personality card limited to 1**.
- Combat / Physical Combat / Energy Combat / Non-Combat / Battleground / Location: **limit 3** unless named/otherwise.
- **Named cards limit 4** if the title name matches your MP's name (unless otherwise).

## Card types (CRD §4)
Personality, Mastery, Sensei, Dragon Ball, Combat, Physical Combat, Energy Combat, Non-Combat, **Drill** (stays in play; discarded when MP gains/loses a level), Location/Battleground (skip Combat Step when played).

## Styles / alignment
- 6 Martial Arts Styles: **Red, Blue, Orange, Black, Saiyan, Namekian**. **Freestyle** = no style.
- **Tokui-Waza**: deck of only Freestyle + one style's cards + that style's Mastery (7 kinds incl. Freestyle).
- **Hero** = blue background, **Villain** = red background; Rogue = either.

## Keywords (CRD §7) — to implement incrementally
Empower (damage boost, announced in step 2), Endurance (life-card damage prevention, step 13), Focused (unstoppable), Fusion (combine personalities), Defense Shield (step 7), starburst (defensive marker), plus card-specific keywords.
