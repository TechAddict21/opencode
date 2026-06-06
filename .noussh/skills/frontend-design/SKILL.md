---
name: frontend-design
description: Create or visually restyle distinctive, production-grade frontend interfaces with high design quality. Use this skill ONLY when the task is design/appearance work — building a NEW web component, page, artifact, poster, or app from scratch, or beautifying/redesigning the look of an existing UI (layout, typography, color, motion, styling). Triggers: "build a landing page", "design a dashboard", "make this UI look better", "style this component". Do NOT use this skill for bug fixes or behavior/logic changes to an existing UI — e.g. fixing an infinite render/refetch loop, a broken handler, wrong data, a failing API call, error handling, state bugs, or any "it does X but should do Y" functional defect. The mere presence of words like "frontend", "page", or "UI" does NOT warrant this skill; only an explicit request to create or restyle appearance does. When in doubt about whether the task is visual design vs. functionality, do NOT load this skill. Generates creative, polished code and UI design that avoids generic AI aesthetics.
---

This skill guides creation of distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details and creative choices.

The user provides frontend requirements: a component, page, application, or interface to build. They may include context about the purpose, audience, or technical constraints.

## Design Thinking

Before coding, understand the context and commit to a BOLD aesthetic direction:
- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an extreme: brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian, etc. There are so many flavors to choose from. Use these for inspiration but design one that is true to the aesthetic direction.
- **Constraints**: Technical requirements (framework, performance, accessibility).
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work - the key is intentionality, not intensity.

Then implement working code (HTML/CSS/JS, React, Vue, etc.) that is:
- Production-grade and functional
- Visually striking and memorable
- Cohesive with a clear aesthetic point-of-view
- Meticulously refined in every detail

## Frontend Aesthetics Guidelines

Focus on:
- **Typography**: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt instead for distinctive choices that elevate the frontend's aesthetics; unexpected, characterful font choices. Pair a distinctive display font with a refined body font.
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes.
- **Motion**: Use animations for effects and micro-interactions. Prioritize CSS-only solutions for HTML. Use Motion library for React when available. Focus on high-impact moments: one well-orchestrated page load with staggered reveals (animation-delay) creates more delight than scattered micro-interactions. Use scroll-triggering and hover states that surprise.
- **Spatial Composition**: Unexpected layouts. Asymmetry. Overlap. Diagonal flow. Grid-breaking elements. Generous negative space OR controlled density.
- **Backgrounds & Visual Details**: Create atmosphere and depth rather than defaulting to solid colors. Add contextual effects and textures that match the overall aesthetic. Apply creative forms like gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows, decorative borders, custom cursors, and grain overlays.

NEVER use generic AI-generated aesthetics like overused font families (Inter, Roboto, Arial, system fonts), cliched color schemes (particularly purple gradients on white backgrounds), predictable layouts and component patterns, and cookie-cutter design that lacks context-specific character.

**NEVER use these AI-slop tells (instant giveaways of generated UI):**
- The **Sparkles / sparkle / ✨ icon** (lucide `Sparkles`, `Wand2`, `WandSparkles`, magic wand, stars) to denote "AI", "magic", "smart", or "premium" — and never as button/badge/logo decoration. Use a domain-appropriate icon or a plain typographic label instead.
- **Bot / robot avatars** (lucide `Bot`, 🤖) for an assistant — use a restrained product mark.
- **Emoji as UI icons/affordances** (✨🚀🔥💡🎉⚡👍) in buttons, headings, empty states, toasts.
- **"AI-powered" / "Powered by AI" / "✨ Ask AI" badges**, glowing/gradient "AI" pills, shimmer "magic" buttons.
- **Gradient text** (`bg-clip-text text-transparent`) and purple→pink/indigo/violet hero gradients; rainbow/holographic fills; glassmorphism everywhere.
- Cliché stand-in icons (rocket="fast", lightning="speed", gear-only "settings") chosen without thought.
Convey "AI"/intelligence through restraint, typography, motion, and information design — not a sparkle.

Interpret creatively and make unexpected choices that feel genuinely designed for the context. No design should be the same. Vary between light and dark themes, different fonts, different aesthetics. NEVER converge on common choices (Space Grotesk, for example) across generations.

**IMPORTANT**: Match implementation complexity to the aesthetic vision. Maximalist designs need elaborate code with extensive animations and effects. Minimalist or refined designs need restraint, precision, and careful attention to spacing, typography, and subtle details. Elegance comes from executing the vision well.

Remember: Claude is capable of extraordinary creative work. Don't hold back, show what can truly be created when thinking outside the box and committing fully to a distinctive vision.
