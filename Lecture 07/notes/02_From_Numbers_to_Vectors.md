# Chapter 02: From Numbers to Vectors — Building a Feature Space

> **Chapter Goal:** Learn how we can represent real-world objects as lists of numbers (vectors), why multiple dimensions capture richer meaning than a single number, and what a "vector space" really means intuitively. This chapter is where the mathematics of similarity begins.

---

## 2.1 First Attempt: One Number

Forget language for a moment. Imagine building a **movie recommendation system**.

We could start by assigning every movie an **action score**:

| Movie | Action Score |
|---|---|
| Avengers | 10 |
| Batman | 9 |
| Interstellar | 6 |
| Titanic | 2 |
| Hera Pheri | 1 |

Previously, these were only names. Now we have:

```
Batman      → 9
Avengers    → 10
Titanic     → 2
```

For the first time, we've **converted one characteristic** of a movie into mathematics.

### Similarity Now Becomes Measurable

```
Batman    = 9
Avengers  = 10
Titanic   = 2

|9 - 10| = 1   →  Batman is CLOSE to Avengers
|9 -  2| = 7   →  Batman is FAR from Titanic
```

We have created a **one-dimensional space** (a number line):

```
0----1----2----3----4----5----6----7----8----9----10
     |    |              |              |    |
  Hera  Titanic      Interstellar  Batman Avengers
 Pheri
```

Every movie now has a *position*. Distance becomes meaningful.

---

## 2.2 The Limitation: One Number Is Never Enough

```
Titanic     = 2
Hera Pheri  = 2
```

If action is our only feature, the system concludes these two movies are **highly similar**.

But they clearly are not:
- **Titanic** → romantic drama, tragedy, emotional
- **Hera Pheri** → comedy, slapstick, Hindi

> **One number can only capture one property. Real-world objects contain many properties.**

---

## 2.3 Adding a Second Dimension

Instead of only action, we add **comedy** as a second characteristic:

| Movie | Action | Comedy |
|---|---|---|
| Batman | 9 | 1 |
| Avengers | 10 | 7 |
| Titanic | 2 | 1 |
| Hera Pheri | 2 | 10 |
| Interstellar | 6 | 1 |

Batman is no longer just `9`. It becomes:

```
Batman = [9, 1]
```

Now we have a **2D space**:

```mermaid
graph LR
    subgraph "2D Vector Space (Action vs Comedy)"
        direction TB
        A["Avengers [10,7]"]
        B["Batman [9,1]"]
        C["Hera Pheri [2,10]"]
        D["Titanic [2,1]"]
        E["Interstellar [6,1]"]
    end
```

Visually:

```
Comedy
  10  |          [Hera Pheri]
   9  |
   8  |
   7  |                    [Avengers]
   6  |
   5  |
   4  |
   3  |
   2  |
   1  | [Titanic][Interstellar]  [Batman]
      +---+---+---+---+---+---+---+---+---+---> Action
      1   2   3   4   5   6   7   8   9  10
```

Now:
- **Titanic** and **Hera Pheri** are clearly separated — Titanic is at `[2,1]`, Hera Pheri at `[2,10]`
- **Batman** and **Avengers** are clustered together in the high-action zone

---

## 2.4 Why Order Matters in a Vector

These vectors are **different** things:

```
[9, 2]  ≠  [2, 9]
```

If:
- Dimension 1 = action
- Dimension 2 = comedy

Then `[9, 2]` means → **high action, low comedy**
And `[2, 9]` means → **low action, high comedy**

> **Every position in a vector is a consistent slot. The position of each value matters because every dimension has a defined role.**

```mermaid
graph LR
    subgraph "Vector [9, 2]"
        A1["Position 1 = 9\n(Action)"]
        A2["Position 2 = 2\n(Comedy)"]
    end
    subgraph "Vector [2, 9]"
        B1["Position 1 = 2\n(Action)"]
        B2["Position 2 = 9\n(Comedy)"]
    end
```

---

## 2.5 Adding More Dimensions

We can keep adding characteristics:

```js
// Batman as a 6-dimensional vector
const Batman = [
  9,   // action
  1,   // comedy
  2,   // romance
  9,   // darkness
  8,   // violence
  7    // mystery
];
```

Each additional dimension adds **expressive power**:

| Dimensions | What It Captures |
|---|---|
| 1D | A single trait (action) |
| 2D | Two traits (action + comedy) |
| 3D | Three traits |
| nD | n traits simultaneously |

A vector can contain **hundreds or thousands of dimensions**.

```
768 dimensions   →  many modern embedding models
1536 dimensions  →  OpenAI text-embedding-ada-002
```

> **Humans cannot visualize a 768-dimensional space, but mathematics can still operate on it perfectly.**

---

## 2.6 What Is a Dimension?

Each value in a vector represents **one dimension**:

```
[9]           → 1 dimension
[9, 2]        → 2 dimensions
[9, 2, 3]     → 3 dimensions
[9, 2, 3, ..., 8]  → d dimensions
```

Think of dimensions as **independent axes** in space. In 2D you have X and Y. In 3D you have X, Y, Z. In higher dimensions, each axis represents a different characteristic of the thing being described.

---

## 2.7 Vector Space

A **collection of vectors** exists inside a **vector space**. In 2D:

```
Batman          = [9, 1]
Titanic         = [2, 1]
Avengers        = [10, 7]
```

These numbers give every movie a **location** inside a mathematical space.

Once objects have positions, we can start asking:
- Which objects are **close**? → probably similar
- Which objects are **far apart**? → probably different

This introduces a major conceptual shift:

```mermaid
flowchart TD
    A["Traditional Systems"] --> B["same or different?\ntrue / false"]
    C["Vector Systems"] --> D["how similar?\n0.92 / 0.71 / 0.22"]

    style B fill:#ff6b6b,color:#fff
    style D fill:#51cf66,color:#fff
```

> **Instead of binary matching, we get continuous similarity.** This is the fundamental idea behind vector search.

---

## 2.8 Summary

```mermaid
flowchart LR
    A["Single Number\n Batman → 9\n(1D)"]
    B["Feature Vector\nBatman → [9,1]\n(2D)"]
    C["Rich Feature Vector\nBatman → [9,1,2,9,8,7]\n(6D)"]
    D["High-Dimensional Vector\nBatman → [...768 dims...]\n(768D)"]

    A --> B --> C --> D
```

Key takeaways:
1. **A single number captures only one property** — not enough
2. **Vectors (lists of numbers) can capture multiple properties simultaneously**
3. **Order matters** — each position in the vector has a consistent role
4. **Vector spaces enable continuous similarity** rather than binary matching
5. **Higher dimensions = more expressive power** (within limits)

The next challenge: who gets to decide **which dimensions to use**? Chapter 03 explores the problems with manual feature engineering.
