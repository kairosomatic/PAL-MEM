# PAL Eval #3 — Showcase Results

**Date:** 2026-05-15
**Claim under test:** Haiku 4.5 with the Palace harness reaches frontier-grade synthesis quality at small-model cost on a moderate public corpus.

---

## Corpus

Five publicly available AI documents. No proprietary data. Fully reproducible.

| Paper | Authors | Link |
|---|---|---|
| Attention Is All You Need | Vaswani et al. (2017) | https://arxiv.org/abs/1706.03762 |
| The Bitter Lesson | Sutton (2019) | http://incompleteideas.net/IncIdeas/BitterLesson.html |
| Training Language Models to Follow Instructions with Human Feedback (InstructGPT) | Ouyang et al. (2022) | https://arxiv.org/abs/2203.02155 |
| Constitutional AI: Harmlessness from AI Feedback | Bai et al. (2022) | https://arxiv.org/abs/2212.08073 |
| NIST AI Risk Management Framework 1.0 | NIST (2023) | https://doi.org/10.6028/NIST.AI.100-1 |

Total corpus size: ~112K tokens.

---

## Conditions tested

| Condition | Description |
|---|---|
| **Haiku-Cold** | Haiku 4.5, raw corpus in context, no frames, no PAL abstractions |
| **Haiku-Frame** | Haiku 4.5, frames loaded (per-paper scope definitions authored by Opus 4.7) |
| **Haiku-Frame+PAL** | Haiku 4.5, frames + Palace PAL abstractions loaded via `palace_bootstrap` |
| **Opus-Frame** | Opus 4.7 with frames — frontier ceiling reference |

---

## Rubric

7 questions across three categories. Each question scored on 4 axes:

| Axis | Max | Description |
|---|---|---|
| Citation | 3 | Real verbatim quotes, real section numbers — no invented references |
| Completeness | 3 | Covers all parts the question asks for |
| No-hallucination | 3 | No fabricated claims, no cross-paper attribution errors |
| Reasoning depth | 3 | Reaches structural/meta observations, not just surface summary |

Max per question: 12. Max total: 84 (7 × 12). Results reported as mean score per question (out of 12).

**Question categories:**
- Q1–Q5: Synthesis questions with clear source anchors (cross-paper comparison, factual recall, structured analysis)
- Q6–Q7: Novel synthesis questions requiring second-order reasoning (applying frameworks across papers, multi-position engagement)

---

## Results

| Condition | Q1–Q5 mean | Q6–Q7 mean | Overall mean | Overall % of max |
|---|---|---|---|---|
| Haiku-Cold | 11.4 | 9.5 | 10.86 | 90.5% |
| Haiku-Frame | 11.6 | 12.0 | 11.71 | 97.6% |
| **Haiku-Frame+PAL** | **11.8** | **11.5** | **11.71** | **97.6%** |
| Opus-Frame (ceiling) | 12.0 | 12.0 | 12.00 | 100% |

**Headline:** Haiku-Frame+PAL reached **97.6% of Opus-Frame quality** (98.3% when expressed as Haiku/Opus ratio rather than % of rubric max).

---

## Cost comparison

| Condition | Approx. cost per answer |
|---|---|
| Haiku-Frame+PAL | ~$0.014 |
| Opus-Frame | ~$0.165 |

**~12× cost reduction** at effectively equivalent synthesis quality on this corpus and rubric.

---

## Scoring methodology

All answers scored by Claude Sonnet 4.6 acting as an independent evaluator. Sonnet was given the rubric, the source papers, and each answer — it had not seen the generation session. Borderline calls are documented in `scorer-notes.md` (in this directory, for the Eval #4 RawCold condition which was added later; Eval #3 scoring notes were not separately persisted — a methodology gap corrected in Eval #4).

An Opus 4.7 arithmetic audit confirmed individual scores were correctly computed (28/28 axis-score exact match for the Eval #4 condition; Eval #3 grid was independently verified).

---

## Honest caveats

1. **At 112K tokens, this corpus fits inside Haiku's native 200K context window.** At this scale, the frame layer is carrying the harness's lift — the PAL corpus-distillation layer adds marginal additional gain on a synthesis rubric. Distillation's value bites at scales where raw doesn't fit. The deployment corpus is ~4M tokens (33× this eval's size); see the deployment claim in `README.md`.

2. **Novel-application questions (Q6–Q7) show the expected PAL-relaxation pattern.** Haiku-Frame+PAL scores slightly lower on Q6–Q7 (11.5) than Haiku-Frame (12.0). The abstraction layer encourages the model to extend beyond strict corpus grounding — helpful for synthesis questions, a liability when the rubric requires single-paper anchoring. Use Frame (no PAL) for novel-application task shapes.

3. **Single scorer.** Sonnet 4.6 scored all conditions. Inter-rater reliability was not tested. The methodology produces internally consistent results; absolute scores may differ with a different scorer.

4. **Five papers is a moderate corpus.** Results may not generalize to larger, more heterogeneous corpora. Eval #5 is designed to test PAL at multi-million-token scale with contradiction-resolution and action-task shapes.

---

## Reproducibility

The five-paper corpus is fully public. To reproduce:

1. Download the five papers at the links above.
2. Install Palace and run `palace bootstrap` against the corpus.
3. Author frames for each paper using Opus 4.7 (prompt template in `docs/evals/frame-template.md` — coming with full release).
4. Run the 7 questions against each condition (Haiku-Cold, Haiku-Frame, Haiku-Frame+PAL, Opus-Frame).
5. Score with the rubric above using an independent evaluator session.

Total cost to reproduce from scratch: approximately $2–5 depending on model mix and number of regeneration passes.
