import { GoogleGenAI } from "@google/genai";
import { fileToBase64, readFileAsText } from "./fileUtils";

const API_KEY = process.env.API_KEY || '';

export const analyzeFile = async (file: File): Promise<string> => {
  if (!API_KEY) {
    console.warn("Gemini API Key missing");
    return "AI 分析不可用 (缺少 API Key)。";
  }

  try {
    const ai = new GoogleGenAI({ apiKey: API_KEY });
    const model = 'gemini-2.5-flash';
    
    // Check constraints
    if (file.size > 4 * 1024 * 1024) { // 4MB limit for demo analysis
      return "文件过大，跳过 AI 深度分析。";
    }

    if (file.type.startsWith('image/')) {
      const base64Data = await fileToBase64(file);
      const response = await ai.models.generateContent({
        model,
        contents: {
          parts: [
            { inlineData: { mimeType: file.type, data: base64Data } },
            { text: "分析这张图片。提供一个非常简短的中文单句描述，适合作为文件传输的预览说明。" }
          ]
        }
      });
      return response.text || "未生成描述。";
    } else if (file.type === 'text/plain' || file.type === 'application/json' || file.name.endsWith('.md') || file.name.endsWith('.txt')) {
      const textContent = await readFileAsText(file);
      // Truncate text to avoid token limits in this demo context
      const truncatedText = textContent.slice(0, 5000);
      
      const response = await ai.models.generateContent({
        model,
        contents: `分析以下文本内容，并提供文件内容的非常简短的中文单句摘要：\n\n${truncatedText}`
      });
      return response.text || "未生成摘要。";
    } else {
      return `文件类型 (${file.type}) 暂不支持 AI 深度分析，但已准备好传输。`;
    }
  } catch (error) {
    console.error("Gemini Analysis Error:", error);
    return "AI 分析失败，但传输功能不受影响。";
  }
};