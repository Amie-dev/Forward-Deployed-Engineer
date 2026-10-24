// Lecture 16 · Chapters 05 / 06 — connecting vision to language.
//
// Chapter 05 is the machinery: position, projection, attention.
// Chapter 06 is the meaning: what it means for a picture and a word to "match".

// Chapter 05.3 — position is ADDED, never inferred.
// The board's label is "patch content + patch position" (top-left / bottom-right).
// Two identical patches in different places must NOT look identical to the model,
// otherwise "cat on the left" and "cat on the right" are the same sentence.
export function positionOf({ row, col }, { rows, cols }) {
  const vertical = row < rows / 2 ? 'top' : 'bottom';
  const horizontal = col < cols / 2 ? 'left' : 'right';
  return `${vertical}-${horizontal}`;
}

// Chapter 05.2 — the projection layer / adapter: visual vectors → the language
// model's space. Without it the two pipelines are in different coordinate systems
// and attention has nothing meaningful to compare.
export function project(vector) {
  return vector.map((value, index) => Number((value * 0.5 + index * 0.01).toFixed(2)));
}

// Chapter 06.3 — cosine similarity: how close two vectors point.
// This is the quantity alignment training pushes UP for a matching pair.
export function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] ** 2;
    normB += b[index] ** 2;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  // A zero vector has no direction, so it cannot be similar to anything.
  // Say so explicitly instead of letting 0/0 become NaN and leak downstream.
  return denominator === 0 ? 0 : dot / denominator;
}

// Chapter 06.2 — training data is IMAGES + DESCRIPTION. The pair is the lesson.
// Collapse a set of patch vectors into ONE image vector so it can be compared.
// Note: a real model LEARNS this pooling; averaging is the honest stand-in here.
// Keep the sample small — the mean of thousands of unrelated vectors is just noise.
export function averageVector(vectors) {
  return vectors[0].map((_, index) =>
    Number((vectors.reduce((sum, vector) => sum + vector[index], 0) / vectors.length).toFixed(2)));
}

export function trainingPair(description, patches) {
  return { description, imageVector: averageVector(patches.map((patch) => patch.vector)) };
}

// Chapter 06.3 — "how well does this picture match this word?"
export function alignmentScore(textVector, imageVector) {
  return Number(cosine(textVector, imageVector).toFixed(3));
}

// Chapter 05.6 — attention across both modalities: which patch does each word lean on?
// Illustrative only. A real model runs this inside every layer, with softmax weights.
export function attention(textVectors, visualVectors) {
  return textVectors.map((text) => {
    const ranked = visualVectors
      .map((visual) => ({
        index: visual.index,
        score: Number(cosine(text.vector, visual.vector).toFixed(3)),
      }))
      .sort((a, b) => b.score - a.score);
    return { token: text.token, patch: ranked[0].index, score: ranked[0].score };
  });
}
