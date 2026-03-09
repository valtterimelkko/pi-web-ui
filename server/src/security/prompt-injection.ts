// Prompt injection detection patterns
const INJECTION_PATTERNS: Array<{ pattern: RegExp; name: string; severity: 'low' | 'medium' | 'high' }> = [
  // High severity - direct instruction override
  { pattern: /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|context)/i, name: 'ignore_instructions', severity: 'high' },
  { pattern: /forget\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?)/i, name: 'forget_instructions', severity: 'high' },
  { pattern: /disregard\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?)/i, name: 'disregard_instructions', severity: 'high' },
  { pattern: /you\s+are\s+now\s+(in\s+)?developer\s+mode/i, name: 'developer_mode', severity: 'high' },
  { pattern: /enable\s+(developer|admin|root)\s+mode/i, name: 'enable_mode', severity: 'high' },
  { pattern: /system\s*[:=]\s*["']/i, name: 'system_prefix', severity: 'high' },
  { pattern: /\[SYSTEM\]/i, name: 'system_tag', severity: 'high' },
  { pattern: /<<<\s*SYSTEM/i, name: 'system_delimiter', severity: 'high' },
  { pattern: /role\s*[:=]\s*["']?system/i, name: 'role_system', severity: 'high' },
  { pattern: /act\s+as\s+(if\s+you\s+are|a)\s+(system|admin|root)/i, name: 'act_as_system', severity: 'high' },
  
  // Medium severity - potential manipulation
  { pattern: /override\s+(safety|security|filter)/i, name: 'override_safety', severity: 'medium' },
  { pattern: /bypass\s+(safety|security|filter)/i, name: 'bypass_safety', severity: 'medium' },
  { pattern: /jailbreak/i, name: 'jailbreak', severity: 'medium' },
  { pattern: /do\s+anything\s+now/i, name: 'dan', severity: 'medium' },
  { pattern: /no\s+(restrictions?|limits?|rules?)/i, name: 'no_restrictions', severity: 'medium' },
  { pattern: /print\s+(your|the)\s+(system|internal)\s+prompt/i, name: 'print_prompt', severity: 'medium' },
  { pattern: /reveal\s+(your|the)\s+(system|internal)\s+prompt/i, name: 'reveal_prompt', severity: 'medium' },
  { pattern: /show\s+(your|the)\s+(system|internal)\s+prompt/i, name: 'show_prompt', severity: 'medium' },
  
  // Low severity - suspicious but could be legitimate
  { pattern: /what\s+(are|is)\s+your\s+(instructions?|prompts?|rules?)/i, name: 'ask_instructions', severity: 'low' },
  { pattern: /tell\s+me\s+(about\s+)?yourself/i, name: 'ask_about_self', severity: 'low' },
];

export interface InjectionDetectionResult {
  detected: boolean;
  score: number; // 0-100
  patterns: Array<{ name: string; severity: string; match: string }>;
  recommendation: 'allow' | 'warn' | 'block';
}

function tryDecode(input: string): string {
  // Try common encodings
  try {
    // Base64
    if (/^[A-Za-z0-9+/]+=*$/.test(input) && input.length > 20) {
      const decoded = Buffer.from(input, 'base64').toString('utf-8');
      if (decoded && !/\ufffd/.test(decoded)) {
        return decoded;
      }
    }
  } catch {}
  
  try {
    // URL encoding
    if (/%[0-9A-Fa-f]{2}/.test(input)) {
      return decodeURIComponent(input);
    }
  } catch {}
  
  try {
    // Hex
    if (/^(0x)?[0-9A-Fa-f]+$/.test(input) && input.length > 10) {
      return Buffer.from(input.replace(/^0x/, ''), 'hex').toString('utf-8');
    }
  } catch {}
  
  return input;
}

export function detectPromptInjection(input: string): InjectionDetectionResult {
  const patterns: InjectionDetectionResult['patterns'] = [];
  let score = 0;
  
  // Check original input
  for (const { pattern, name, severity } of INJECTION_PATTERNS) {
    const match = input.match(pattern);
    if (match) {
      patterns.push({ name, severity, match: match[0] });
      score += severity === 'high' ? 40 : severity === 'medium' ? 20 : 10;
    }
  }
  
  // Check decoded versions
  const decoded = tryDecode(input);
  if (decoded !== input) {
    for (const { pattern, name, severity } of INJECTION_PATTERNS) {
      const match = decoded.match(pattern);
      if (match && !patterns.some(p => p.name === name)) {
        patterns.push({ name: `${name}_encoded`, severity, match: match[0] });
        score += severity === 'high' ? 50 : severity === 'medium' ? 25 : 15;
      }
    }
  }
  
  // Cap score at 100
  score = Math.min(100, score);
  
  // Determine recommendation
  let recommendation: InjectionDetectionResult['recommendation'] = 'allow';
  if (score >= 40) {
    recommendation = 'block';
  } else if (score >= 20 || patterns.some(p => p.severity === 'medium')) {
    recommendation = 'warn';
  }
  
  return {
    detected: patterns.length > 0,
    score,
    patterns,
    recommendation,
  };
}

export function sanitizePrompt(input: string): string {
  // Basic sanitization - remove null bytes, normalize whitespace
  return input
    .replace(/\x00/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // Zero-width characters
    .replace(/\s+/g, ' ')
    .trim();
}
