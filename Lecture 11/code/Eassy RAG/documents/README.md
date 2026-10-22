# documents/

Place your PDF files here.

Example: `backend-guide.pdf`

When indexing, use:
```
node --input-type=module -e '
import { indexPdf } from "./src/indexPdf.js";

const result = await indexPdf({
  filePath: "./documents/backend-guide.pdf",
  documentId: "backend-guide-v1"
});

console.log(result);
'
```
