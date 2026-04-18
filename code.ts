// SemanticNamer ASI - Figma plugin
// Supports Groq (dynamic model list) and Anthropic (Claude) providers.

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS_ENDPOINT = 'https://api.groq.com/openai/v1/models';
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const ANTHROPIC_MODELS = [
    'claude-opus-4-7',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001'
];

type Provider = 'groq' | 'anthropic';

interface PrunedNode {
    id: string;
    name: string;
    type: string;
    children: PrunedNode[];
}

interface GroqModel {
    id: string;
    owned_by: string;
}

figma.showUI(__html__, { width: 340, height: 380 });

const fetchGroqModels = async (apiKey: string): Promise<string[]> => {
    try {
        const response = await fetch(GROQ_MODELS_ENDPOINT, {
            headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        if (!response.ok) return [];
        const data = await response.json() as { data: GroqModel[] };
        return data.data.map(m => m.id);
    } catch {
        return [];
    }
};

const selectBestGroqModels = (models: string[]): string[] => {
    const preferredPatterns = [
        /70b.*versatile/i,
        /405b/i,
        /127b/i,
        /70b/i,
        /32b/i
    ];
    const scored = models.map(m => {
        let score = 0;
        preferredPatterns.forEach((p, idx) => {
            if (p.test(m)) score = preferredPatterns.length - idx;
        });
        return { model: m, score };
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, 5).map(m => m.model);
};

// Load all saved settings on startup
(async () => {
    const provider = (await figma.clientStorage.getAsync('provider') as Provider | undefined) || 'groq';
    const groqKey = (await figma.clientStorage.getAsync('groq-api-key') as string | undefined) || '';
    const anthropicKey = (await figma.clientStorage.getAsync('anthropic-api-key') as string | undefined) || '';
    const groqModel = (await figma.clientStorage.getAsync('groq-model') as string | undefined) || '';
    const anthropicModel = (await figma.clientStorage.getAsync('anthropic-model') as string | undefined) || ANTHROPIC_MODELS[0];

    let groqModels: string[] = [];
    if (groqKey) {
        const all = await fetchGroqModels(groqKey);
        groqModels = all.length > 0 ? selectBestGroqModels(all) : [];
    }

    figma.ui.postMessage({
        type: 'load-settings',
        provider,
        groqKey,
        anthropicKey,
        groqModel: groqModel || groqModels[0] || '',
        anthropicModel,
        groqModels,
        anthropicModels: ANTHROPIC_MODELS
    });
})();

const sendStatus = (text: string): void => {
    figma.ui.postMessage({ type: 'status-update', text });
};

const MAX_NODES = 60;
const MAX_DEPTH = 5;
let nodeCount = 0;

const traverse = (node: SceneNode, depth = 0): PrunedNode => {
    nodeCount++;
    const pruned: PrunedNode = { id: node.id, name: node.name, type: node.type, children: [] };
    if ('children' in node && depth < MAX_DEPTH && nodeCount < MAX_NODES) {
        for (const child of node.children) {
            if (nodeCount >= MAX_NODES) break;
            pruned.children.push(traverse(child as SceneNode, depth + 1));
        }
    }
    return pruned;
};

const createSystemPrompt = (platform: string, layerTree: string): string =>
    `You are an expert Design System Architect. Rename layers in the hierarchical tree for platform: ${platform}.

**Rules:**
- **iOS (SwiftUI):** UpperCamelCase for views (UserProfileCard), lowerCamelCase for elements (userNameLabel).
- **Android (XML/Compose):** snake_case for IDs (user_name_text_view), UpperCamelCase for components.
- **Web (BEM):** block__element--modifier (auth-form__input--error).
- **Flutter:** UpperCamelCase for Widgets, lowerCamelCase for instances.
- Infer purpose from hierarchy and current names. Be concise.

**Input Tree:**
${layerTree}

**Output:** ONLY a valid JSON object mapping layer ID to new name. No markdown, no explanations. Must be parseable by JSON.parse().`;

const callGroq = async (apiKey: string, model: string, systemPrompt: string): Promise<string> => {
    const response = await fetch(GROQ_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: 'Rename the layers. Return only the JSON mapping.' }
            ],
            temperature: 0.2,
            response_format: { type: 'json_object' }
        })
    });
    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Groq API ${response.status} - ${err.slice(0, 120)}`);
    }
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('Empty response from Groq API.');
    return text;
};

const callAnthropic = async (apiKey: string, model: string, systemPrompt: string): Promise<string> => {
    const response = await fetch(ANTHROPIC_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION
        },
        body: JSON.stringify({
            model,
            max_tokens: 2048,
            system: systemPrompt,
            messages: [{ role: 'user', content: 'Rename the layers. Return only the JSON mapping.' }]
        })
    });
    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Anthropic API ${response.status} - ${err.slice(0, 120)}`);
    }
    const data = await response.json();
    let text = data?.content?.[0]?.text;
    if (!text) throw new Error('Empty response from Anthropic API.');
    // Strip markdown code blocks if present
    text = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    return text;
};

figma.ui.onmessage = async (msg: {
    type: string;
    provider?: Provider;
    key?: string;
    model?: string;
    platform?: string;
}) => {
    if (msg.type === 'save-provider') {
        await figma.clientStorage.setAsync('provider', msg.provider || 'groq');
        return;
    }

    if (msg.type === 'save-api-key') {
        const storageKey = msg.provider === 'anthropic' ? 'anthropic-api-key' : 'groq-api-key';
        await figma.clientStorage.setAsync(storageKey, msg.key || '');
        sendStatus('API key saved.');
        return;
    }

    if (msg.type === 'save-model') {
        const storageKey = msg.provider === 'anthropic' ? 'anthropic-model' : 'groq-model';
        await figma.clientStorage.setAsync(storageKey, msg.model || '');
        sendStatus('Model saved.');
        return;
    }

    if (msg.type === 'fetch-groq-models') {
        if (!msg.key) {
            figma.ui.postMessage({ type: 'groq-models-loaded', models: [] });
            return;
        }
        const all = await fetchGroqModels(msg.key);
        figma.ui.postMessage({ type: 'groq-models-loaded', models: selectBestGroqModels(all) });
        return;
    }

    if (msg.type !== 'rename-layers') return;

    const provider: Provider = msg.provider || 'groq';
    const storageKeyName = provider === 'anthropic' ? 'anthropic-api-key' : 'groq-api-key';
    const storageModelName = provider === 'anthropic' ? 'anthropic-model' : 'groq-model';

    const apiKey = msg.key || (await figma.clientStorage.getAsync(storageKeyName) as string | undefined) || '';
    if (!apiKey) {
        sendStatus(`Error: Please enter your ${provider === 'anthropic' ? 'Anthropic' : 'Groq'} API key.`);
        return;
    }

    const model = msg.model || (await figma.clientStorage.getAsync(storageModelName) as string | undefined) || '';
    if (!model) {
        sendStatus('Error: Please select a model.');
        return;
    }

    const selection = figma.currentPage.selection;
    if (selection.length !== 1) {
        sendStatus('Error: Please select exactly one frame.');
        return;
    }
    if (selection[0].type !== 'FRAME') {
        sendStatus('Error: Selected node must be a FRAME.');
        return;
    }

    sendStatus('Extracting layer tree...');
    nodeCount = 0;
    const layerTree = traverse(selection[0]);
    const truncated = nodeCount >= MAX_NODES;
    const layerTreeString = JSON.stringify(layerTree, null, 2);
    const systemPrompt = createSystemPrompt(msg.platform || 'iOS (SwiftUI)', layerTreeString);
    if (truncated) sendStatus(`Tree truncated to ${MAX_NODES} nodes. Sending to API...`);

    sendStatus(`Sending to ${provider === 'anthropic' ? 'Claude' : 'Groq'} API...`);

    let responseText: string;
    try {
        responseText = provider === 'anthropic'
            ? await callAnthropic(apiKey, model, systemPrompt)
            : await callGroq(apiKey, model, systemPrompt);
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        sendStatus(`Error: ${errMsg}`);
        return;
    }

    let nameMap: Record<string, string>;
    try {
        nameMap = JSON.parse(responseText);
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        sendStatus(`Error: Failed to parse JSON - ${errMsg}`);
        return;
    }

    sendStatus('Applying new names...');
    let renamedCount = 0;
    for (const id of Object.keys(nameMap)) {
        const newName = nameMap[id];
        if (typeof newName !== 'string' || newName.length === 0) continue;
        try {
            const node = await figma.getNodeByIdAsync(id);
            if (node && 'name' in node) {
                (node as BaseNode & { name: string }).name = newName;
                renamedCount++;
            }
        } catch { /* skip */ }
    }

    sendStatus(`Success! Renamed ${renamedCount} layers.`);
};
