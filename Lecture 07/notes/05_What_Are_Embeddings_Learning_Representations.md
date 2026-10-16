# Chapter 05: What Are Embeddings? Learning Representations

> **Chapter Goal:** Understand what embeddings are, how they differ from hand-crafted feature vectors, how training produces useful representations from data, and why the famous "king - man + woman = queen" arithmetic actually works. This is the core conceptual leap of the entire lecture.

---

## 5.1 The Key Insight: Let the Machine Learn

Instead of manually deciding what the dimensions mean, we flip the question:

```
OLD: "Which dimensions should we create?"
NEW: "What task should the model learn to solve?"
```

The correct internal representations **emerge as a consequence** of training on a useful task.

> **An embedding is a learned vector representation of an object in a continuous mathematical space — where geometric relationships encode semantic relationships.**

---

## 5.2 The Formal Definition

An **embedding model** is a function:

```
f(input) → ℝᵈ
```

Where:
- `input` = any real-world object (word, sentence, image, user, etc.)
- `ℝᵈ` = a d-dimensional continuous vector space
- `f` = a model with learned parameters (a neural network)

For example:

```
f("Batman is a dark superhero movie")
  ↓
Embedding Model
  ↓
[0.12, -0.37, 0.91, 0.44, ..., 0.22]   (768 or 1536 dimensions)
```

If the model produces 768-dimensional embeddings:
```
f(text) → ℝ⁷⁶⁸
```

If 1536-dimensional:
```
f(text) → ℝ¹⁵³⁶
```

The **dimensionality is a design choice** of the particular embedding model.

---

## 5.3 How Does Training Know What to Learn?

A machine-learning model doesn't "understand" instructions like:

```
"Understand the English language."
```

Instead, it learns parameters that help it **perform some objective (task)**. Useful internal representations emerge as a *side-effect* of learning to do that task well.

```mermaid
flowchart TD
    Task["Training Task / Objective\ne.g., 'Predict the next word'"]
    Data["Training Data\n(massive amounts of text)"]
    Opt["Optimization\n(Gradient Descent)"]
    
    Task --> Train["Model Training"]
    Data --> Train
    Opt --> Train
    
    Train --> Repr["Useful Internal Representations\n(embeddings)"]
    Repr --> Apps["Applications:\nSearch, Recommendations,\nSemantic Understanding"]

    style Repr fill:#51cf66,color:#000
    style Apps fill:#74c0fc,color:#000
```

The model is never explicitly told what "king" means, what "queen" means, or how they relate. It figures this out through patterns in the training data.

---

## 5.4 Meaning Through Context

Consider training data that repeatedly contains:

```
The king ruled the kingdom.
The queen ruled the kingdom.

The king lived in the palace.
The queen lived in the palace.

The king wore the crown.
The queen wore the crown.
```

And separately:

```
I ate a banana.
The banana is a fruit.

The apple is a fruit.
I ate an apple.
```

Notice what's happening:
- `king` and `queen` appear in **similar surrounding words**
- `banana` and `apple` appear in **similar surrounding words**
- `king` and `banana` appear in **very different contexts**

This pattern reflects a famous principle from linguistics:

> **"You shall know a word by the company it keeps."** — J.R. Firth (1957)

Words that appear in similar contexts tend to have **related meanings or roles**.

```mermaid
graph LR
    subgraph "Same Context → Similar Vectors"
        K["king"] -. "appears near crown,\npalace, ruled" .-> Q["queen"]
    end

    subgraph "Different Context → Different Vectors"
        K2["king"] -. "very different\ncontexts" .-> B["banana"]
    end

    style K fill:#ffd43b,color:#000
    style Q fill:#ffd43b,color:#000
    style B fill:#ff6b6b,color:#fff
```

---

## 5.5 A Toy Training Objective — Predict Nearby Words

Imagine a simple task: **Given one word, predict nearby words** (this is roughly how Word2Vec works).

**Sentence:** `"The king wears a crown"`

```
Input: king
Nearby words: the, wears, a, crown
```

Now consider: `"The queen wears a crown"`

```
Input: queen
Nearby words: the, wears, a, crown
```

Since `king` and `queen` need to produce **similar predictions** to succeed at the task, it becomes useful for their internal representations to become **similar**.

```mermaid
sequenceDiagram
    participant Training Data
    participant Model
    participant EmbeddingSpace

    Training Data->>Model: "The king wears a crown"
    Note over Model: king must predict → [crown, wears, palace...]

    Training Data->>Model: "The queen wears a crown"
    Note over Model: queen must predict → [crown, wears, palace...]

    Model->>EmbeddingSpace: king and queen develop similar vectors
    Note over EmbeddingSpace: Before training: king ●         ● queen (far apart)
    Note over EmbeddingSpace: After training: king ●●queen (close together)
```

Meanwhile, `banana` never appears near `crown`, `palace`, or `kingdom` — so its vector drifts to a completely different region of the space.

**The relationship emerges from patterns in data.** No human explicitly entered: `"king is similar to queen"`.

---

## 5.6 The Embedding Table

In a simple model, each word in the vocabulary gets its own vector stored in an **embedding table** (also called an embedding lookup table or embedding matrix):

| Word | d1 | d2 | d3 |
|---|---|---|---|
| king | 0.21 | -0.71 | 0.45 |
| queen | 0.19 | -0.68 | 0.49 |
| dog | -0.51 | 0.22 | 0.78 |
| cat | -0.48 | 0.19 | 0.73 |
| banana | 0.89 | 0.54 | -0.13 |
| apple | 0.84 | 0.57 | -0.09 |

Observations:
- `king` and `queen` have **very similar values** → they appear in similar contexts
- `dog` and `cat` have **very similar values** → they appear in similar contexts
- `banana` and `apple` have **very similar values** → they appear in similar contexts
- But `king` and `banana` are in **completely different regions** of the space

```mermaid
graph LR
    subgraph "Learned Embedding Space"
        direction LR
        K["king"]
        Q["queen"]
        D["dog"]
        C["cat"]
        BA["banana"]
        AP["apple"]

        K --- Q
        D --- C
        BA --- AP
    end
```

---

## 5.7 How Training Changes the Embeddings — Step by Step

The training cycle:

```mermaid
flowchart TD
    S1["1. Start with random vectors\nking = [0.3, -0.1, 0.9, ...]"]
    S2["2. Use them to make a prediction\nInput: king → Predict: banana (wrong!)"]
    S3["3. Compare prediction with correct answer\nExpected: crown, palace, ruled..."]
    S4["4. Calculate the error (loss)\nLoss → HIGH"]
    S5["5. Adjust parameters via gradient descent\nSlightly nudge king's vector"]
    S6["6. Repeat for millions of examples"]
    S7["Representations gradually organize into\nsemantically meaningful structure"]

    S1 --> S2 --> S3 --> S4 --> S5 --> S6 --> S7

    style S7 fill:#51cf66,color:#000
    style S4 fill:#ff6b6b,color:#fff
```

Over enormous numbers of training examples, the vectors that started **randomly scattered** gradually organize themselves:

```
BEFORE TRAINING (random):
  king                   banana
             dog
  queen                           apple
                    cat

    ↓ millions of training examples ↓

AFTER TRAINING (meaningful):
  king ●●● queen

  dog  ●●● cat

  banana ●●● apple
```

---

## 5.8 The Famous King-Queen-Man-Woman Arithmetic

One of the most celebrated properties of well-trained word embeddings is **vector arithmetic**:

```
king - man + woman ≈ queen
```

### Why Does This Work?

If the embeddings capture underlying structure:

```
king  ≈ [royalty, male, authority, ...]
queen ≈ [royalty, female, authority, ...]
man   ≈ [male, human, adult, ...]
woman ≈ [female, human, adult, ...]
```

Then:
```
king - man  →  removes the "male" component  →  leaves [royalty, authority, ...]
+ woman     →  adds the "female" component   →  [royalty, female, authority, ...]
≈ queen
```

```mermaid
graph LR
    K["king\n[royalty, male, authority]"]
    M["- man\n[male, human]"]
    W["+ woman\n[female, human]"]
    Q["≈ queen\n[royalty, female, authority]"]

    K --> M --> W --> Q

    style K fill:#ffd43b,color:#000
    style Q fill:#51cf66,color:#000
```

> **This arithmetic works because the embedding space encodes relationships as consistent geometric directions.** The "gender direction" in the vector space is the same for both king/queen and man/woman pairs.

### More Examples of Embedding Arithmetic

```
Paris - France + Germany ≈ Berlin
doctor - man + woman ≈ nurse
walking - walk + swim ≈ swimming
```

These are emergent properties — nobody programmed them. They arise from the statistical structure of language itself.

---

## 5.9 What the Model "Discovers" (With a Caveat)

In a manually designed vector, every dimension has a clear human label:

```js
// Manually labeled dimensions — human-readable
const king = {
  royalty: 1.0,
  gender: "male",
  authority: 0.9
};
```

In a learned embedding, the dimensions are **not human-labeled**:

```
king = [0.21, -0.71, 0.45, 0.88, -0.23, ...]
```

We **cannot directly read** what each dimension means. But some interpretable structure often emerges when we analyze the space. These learned internal characteristics are called:

- **Latent features** — features that influence the output but aren't directly observed
- **Latent factors** — in recommendation systems
- **Latent representations** — the general term

> **The model discovers useful structure. But we must be careful — it's not discovering human-interpretable "features." It's discovering whatever mathematical structure helps solve the training objective.**

---

## 5.10 Summary

```mermaid
flowchart TD
    A["Real-World Object\ne.g., Batman"]
    B["Need Numerical Representation"]
    C["Manual Vector\nBatman = [Action=9, Romance=2, Darkness=9]"]
    D["Does Not Scale"]
    E["Training Objective + Training Data + Gradient Descent"]
    F["Learned Vector\nBatman = [0.23, -0.81, 0.47, ...]"]
    G["EMBEDDING"]

    A --> B --> C --> D --> E --> F --> G

    style C fill:#ff9f43,color:#fff
    style G fill:#51cf66,color:#000
```

### Key Concepts Recap

| Concept | Description |
|---|---|
| **Embedding** | A learned position in a continuous vector space |
| **Embedding Table** | Lookup table of learned vectors per vocabulary item |
| **Training Objective** | The task the model is trained to solve (e.g., predict next word) |
| **Latent Features** | Learned internal structure, not human-readable |
| **Vector Arithmetic** | Semantic relationships encoded as geometric directions |
| **"Company it keeps"** | Words in similar contexts → similar vectors |

> **An embedding is not the meaning itself. It is a position inside a learned mathematical space where useful relationships in meaning or behavior become relationships in geometry.**

The next chapter (Chapter 06) answers: what can we actually *do* with these embeddings once we have them?
