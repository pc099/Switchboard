/**
 * Embedding Service
 * Generates text embeddings using a local transformer model
 */

// @ts-ignore - Transformers.js types are incomplete
import { pipeline } from '@xenova/transformers';
import { createHash } from 'crypto';
import { logger } from '../utils/logger.js';

// Singleton pattern for the embedding pipeline
let embeddingPipeline: any = null;
let isLoading = false;
let loadPromise: Promise<any> | null = null;

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIMENSION = 384;

/**
 * Initialize the embedding model
 * Loads the model into memory (first call takes ~2-5 seconds)
 */
export async function initializeEmbeddings(): Promise<void> {
  if (embeddingPipeline) return;
  
  if (isLoading && loadPromise) {
    await loadPromise;
    return;
  }
  
  isLoading = true;
  logger.info('Loading embedding model...');
  
  try {
    loadPromise = pipeline('feature-extraction', MODEL_NAME, {
      quantized: true, // Use quantized model for faster inference
    });
    
    embeddingPipeline = await loadPromise;
    logger.info({ model: MODEL_NAME, dimension: EMBEDDING_DIMENSION }, 'Embedding model loaded');
  } catch (err) {
    logger.error({ err }, 'Failed to load embedding model');
    throw err;
  } finally {
    isLoading = false;
    loadPromise = null;
  }
}

/**
 * Generate embedding vector for text
 * @param text - Input text to embed
 * @returns 384-dimensional embedding vector
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  if (!embeddingPipeline) {
    await initializeEmbeddings();
  }
  
  if (!embeddingPipeline) {
    throw new Error('Embedding model not initialized');
  }
  
  const startTime = performance.now();
  
  try {
    // Truncate very long texts to avoid memory issues
    const truncatedText = text.slice(0, 512);
    
    // Generate embedding
    const output = await embeddingPipeline(truncatedText, {
      pooling: 'mean',
      normalize: true,
    });
    
    // Convert to plain array
    const embedding = Array.from(output.data as Float32Array);
    
    const latencyMs = Math.round(performance.now() - startTime);
    logger.debug({ textLength: text.length, latencyMs }, 'Generated embedding');
    
    return embedding;
  } catch (err) {
    logger.error({ err }, 'Failed to generate embedding');
    throw err;
  }
}

/**
 * Generate a hash of the prompt for quick exact-match lookups
 */
export function hashPrompt(text: string): string {
  return createHash('sha256').update(text).digest('hex').substring(0, 16);
}

/**
 * Calculate cosine similarity between two vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have equal length');
  }
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export const EMBEDDING_DIMENSION_SIZE = EMBEDDING_DIMENSION;
