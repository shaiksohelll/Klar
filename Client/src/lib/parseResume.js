import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// Configure the worker the Vite way — done once at module load.
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Extract plain text from a File object.
 * Supports: .pdf (pdfjs-dist), .docx (mammoth), .txt / plain text.
 *
 * @param {File} file
 * @returns {Promise<string>}
 */
export async function extractTextFromFile(file) {
  const name = file.name.toLowerCase();

  if (name.endsWith(".pdf")) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str).join(" "));
    }
    return pages.join("\n");
  }

  if (name.endsWith(".docx")) {
    // Dynamic import keeps mammoth out of the initial bundle.
    const mammoth = await import("mammoth");
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    return result.value;
  }

  if (name.endsWith(".txt") || file.type === "text/plain") {
    return file.text();
  }

  throw new Error(
    `Unsupported file type: "${file.name}". Please upload a PDF, DOCX, or plain-text file.`
  );
}
