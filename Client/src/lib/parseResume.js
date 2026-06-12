import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// Configure the worker the Vite way — done once at module load.
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_EXTRACTED_CHARS = 100000; // Limit extracted text to prevent memory issues

/**
 * Extract plain text from a File object.
 * Supports: .pdf (pdfjs-dist), .docx (mammoth), .txt / plain text.
 *
 * @param {File} file
 * @returns {Promise<string>}
 */
export async function extractTextFromFile(file) {
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(`"${file.name}" is too large (max 10 MB). Please upload a smaller file.`);
  }

  const name = file.name.toLowerCase();

  if (name.endsWith(".pdf")) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let extractedText;
    try {
      const pages = [];
      let totalChars = 0;
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items
          .filter((item) => item && typeof item.str === "string")
          .map((item) => item.str)
          .join(" ");
        
        if (totalChars + pageText.length > MAX_EXTRACTED_CHARS) {
          pages.push(pageText.substring(0, MAX_EXTRACTED_CHARS - totalChars));
          break;
        }
        
        pages.push(pageText);
        totalChars += pageText.length;
      }
      extractedText = pages.join("\n");
    } finally {
      // Defensive cleanup: never let destroy() abort a successful extraction
      try {
        if (pdf && typeof pdf.destroy === "function") {
          await pdf.destroy();
        }
      } catch {
        // Ignore cleanup errors — we already have the text
      }
    }
    return extractedText;
  }

  if (name.endsWith(".docx")) {
    // Dynamic import keeps mammoth out of the initial bundle.
    const mammothModule = await import("mammoth");
    const mammoth = mammothModule.default ?? mammothModule;
    const arrayBuffer = await file.arrayBuffer();
    const extractRawText = mammoth.extractRawText ?? mammothModule.extractRawText;
    if (typeof extractRawText !== "function") {
      throw new Error("Failed to load DOCX parser.");
    }
    const result = await extractRawText({ arrayBuffer });
    const text = result.value;
    return text.length > MAX_EXTRACTED_CHARS 
      ? text.substring(0, MAX_EXTRACTED_CHARS)
      : text;
  }

  if (name.endsWith(".txt") || file.type === "text/plain") {
    const text = await file.text();
    return text.length > MAX_EXTRACTED_CHARS 
      ? text.substring(0, MAX_EXTRACTED_CHARS)
      : text;
  }

  throw new Error(
    `Unsupported file type: "${file.name}". Please upload a PDF, DOCX, or plain-text file.`
  );
}
