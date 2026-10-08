/**
 * Reads the whole monitored conversation for a period — mentions (grievances)
 * and monitored-source posts (contents joined to their analyses) — and maps
 * each post to the shape the report engine works on, using the labels the
 * existing analysis pipeline already wrote. No new model calls.
 *
 * Mapping (all from existing analysis fields):
 *   relevant                 client_relevance === 'relevant'
 *   stance_toward_subject    posts that name the subject: leader_target sentiment toward them,
 *                            else target_sentiment when the post targets the ruling side; else unclear
 *   stance_toward_protest    stance toward the axis (the state government): leader_target's
 *                            government_stance_side, else political_stance read against its target
 *   narratives               the issue topic (analysis.topic, or the topic lexicon)
 *   risk_band                from intent: threats / violence with explicit violent wording → critical;
 *                            hate, communal, misinformation, harassment → high; abuse or an unconfirmed
 *                            threat flag → medium; else low
 *   places                   Maharashtra districts named in the text
 */

const Grievance = require('../../models/Grievance');
const Content = require('../../models/Content');
const Analysis = require('../../models/Analysis');
const { districtIn } = require('../../utils/mhLeaderMatch');
const { topicFor } = require('../../utils/mhTopicLexicon');

const CRITICAL_INTENTS = new Set(['Hate_Speech_Threat', 'Hate_Speech_Threat_Extremist', 'Communal_Violence', 'threat', 'Sexual_Violence']);
const HIGH_INTENTS = new Set(['Hate_Speech', 'Communal_Content', 'Misinformation', 'Harassment']);
const INTENT_LABEL = {
    Hate_Speech_Threat: 'Hate speech with a threat', Hate_Speech_Threat_Extremist: 'Extremist threat', Communal_Violence: 'Communal violence',
    threat: 'Threat', Sexual_Violence: 'Sexual violence', Hate_Speech: 'Hate speech', Communal_Content: 'Communal content',
    Misinformation: 'Misinformation', Harassment: 'Harassment', Abusive: 'Abusive language',
};
// The model's threat labels are often raised by ordinary criticism, so a post is only
// put in the critical band when its text also uses explicit violent language.
const VIOLENCE_RX = new RegExp([
    '\\b(kill|murder|shoot|lynch|behead|stab|slit|bomb|hang (him|them|her)|burn (him|them|her|alive)|beat (him|them|her) up|death to|thrash)\\b',
    'मार डालो', 'मार दो', 'मारो', 'जान से', 'गोली मार', 'फांसी', 'जला दो', 'काट दो', 'ठोको', 'खत्म कर दो',
    'जीवे मार', 'ठार मार', 'मारून टाक', 'जाळून', 'फासावर', 'गोळ्या घाल', 'हत्या कर',
].join('|'), 'i');

const SENTIMENT_TO_STANCE = { positive: 'supportive', negative: 'critical', neutral: 'neutral' };
const RULING_TARGETS = new Set(['ruling_party', 'state_government']);

const slug = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const extractHashtags = (text) => [...new Set((String(text || '').match(/#[\p{L}\p{N}_]+/gu) || []).map((h) => h.toLowerCase()))];
const scriptLanguage = (s) => {
    const v = String(s || '').toLowerCase();
    if (!v) return null;
    if (/devanagari|hindi|marathi/.test(v) && /latin|english|hinglish/.test(v)) return 'mixed';
    if (/devanagari|hindi|marathi/.test(v)) return 'deva';
    if (/latin|english|hinglish/.test(v)) return 'latn';
    return null;
};

/** Stance toward the state government from political_stance, read against what the post targets. */
const governmentStance = (a, lt) => {
    if (lt?.government_stance_side === 'pro') return 'supportive';
    if (lt?.government_stance_side === 'anti') return 'critical';
    if (lt?.government_stance_side === 'neutral') return 'neutral';
    const ps = a.political_stance || a.stance;
    if (!ps || ps === 'unrelated') return 'unclear';
    if (ps === 'neutral') return 'neutral';
    const pro = ps.startsWith('pro_target');
    if (RULING_TARGETS.has(a.target)) return pro ? 'supportive' : 'critical';
    if (a.target === 'opposition') return pro ? 'critical' : 'supportive';
    return 'unclear';
};

/**
 * Map one analysed post. `a` is the analysis (grievance.analysis, or the content's
 * Analysis.llm_analysis merged with its top-level fields); `base` the post fields.
 */
const mapPost = (base, a, subject) => {
    const lt = a.leader_target || a.llm_analysis?.leader_target || null;
    const done = Boolean(a.sentiment || a.llm_analysis?.sentiment);
    const text = base.text || '';
    const mentioned = (a.mentioned_entities || []).some((e) => e && e.key === subject.key)
        || lt?.target_leader_key === subject.key
        || subject.rx.test(text);

    let stanceSubject = 'unclear';
    if (mentioned) {
        if (lt?.target_leader_key === subject.key && lt.leader_sentiment) stanceSubject = SENTIMENT_TO_STANCE[lt.leader_sentiment] || 'unclear';
        else if (RULING_TARGETS.has(a.target) && a.target_sentiment) stanceSubject = SENTIMENT_TO_STANCE[a.target_sentiment] || 'unclear';
    }
    const stanceAxis = governmentStance(a, lt);
    const intent = a.intent || a.category || 'Normal';
    let band = 'low';
    let unconfirmed = false;
    if (CRITICAL_INTENTS.has(intent)) {
        if (VIOLENCE_RX.test(text)) band = 'critical';
        else { band = 'medium'; unconfirmed = true; }
    } else if (HIGH_INTENTS.has(intent)) band = 'high';
    // The model's own risk_level is 'high' for about 40% of posts, so it is not used on its own.
    else if (intent === 'Abusive') band = 'medium';
    // The model's topic, else the lexicon's (it only fills a missing topic).
    const topic = (typeof a.topic === 'string' && a.topic) || topicFor(text)?.topic || null;
    const district = districtIn({ text });
    const reason = band === 'low' ? null : [
        unconfirmed ? `Model-flagged ${String(INTENT_LABEL[intent] || 'threat').toLowerCase()}, not confirmed in the text` : INTENT_LABEL[intent],
        (a.explanation || a.llm_analysis?.reasoning || '').slice(0, 160),
    ].filter(Boolean).join(': ');

    let targetType = 'other';
    if (mentioned && stanceSubject !== 'unclear') targetType = 'subject';
    else if (RULING_TARGETS.has(a.target)) targetType = 'government';
    else if (a.target === 'opposition') targetType = 'opposition';

    return {
        ...base,
        hashtags: extractHashtags(text),
        language: scriptLanguage(a.language_detected),
        analysis: {
            status: done ? 'done' : 'pending',
            is_relevant: done ? (a.client_relevance || a.llm_analysis?.client_relevance) === 'relevant' : null,
            category: stanceAxis === 'critical' || stanceSubject === 'critical' ? 'criticism'
                : (stanceAxis === 'supportive' || stanceSubject === 'supportive' ? 'reaction_support' : 'neutral_reporting'),
            target: a.target_entity_canonical || a.target_entity || a.llm_analysis?.target_entity || null,
            target_type: targetType,
            stance_toward_subject: stanceSubject,
            stance_toward_protest: stanceAxis,
            sentiment: a.sentiment || null,
            narratives: topic ? [slug(topic)] : [],
            topic,
            entities: [...new Set((a.mentioned_entities || []).map((e) => e?.canonical).filter(Boolean))],
            places: district ? [district] : [],
            activity: null,
            claims: intent === 'Misinformation' ? [{ text: text.replace(/\s+/g, ' ').slice(0, 140), kind: 'allegation' }] : [],
            summary: null,
            account_type: base.verified ? 'public_figure' : 'individual',
            risk_band: band,
            risk_reason: reason,
            review: null,
        },
    };
};

const metricsOf = (m = {}) => ({
    likes: m.likes ?? null,
    comments: m.comments ?? m.replies ?? null,
    shares: (m.retweets ?? 0) + (m.quotes ?? 0) || null,
    views: m.views ?? null,
});
const total = (m) => ['likes', 'comments', 'shares', 'views'].reduce((s, k) => s + (m[k] || 0), 0);
const mediaOf = (items = []) => items.map((x) => ({
    kind: /video|gif/.test(x?.type || '') ? 'video' : 'photo',
    url: x?.video_url || x?.s3_url || x?.url || x?.original_url || null,
})).filter((x) => x.url);

/**
 * All monitored posts published in [from, to] (either bound optional), mapped
 * and de-duplicated across mentions and monitored sources.
 */
const loadPosts = async ({ from = null, to = null }, subject) => {
    const range = (field) => {
        const q = {};
        if (from || to) {
            q[field] = {};
            if (from) q[field].$gte = new Date(from);
            if (to) q[field].$lte = new Date(to);
        }
        return q;
    };

    const grievances = await Grievance.find({ ...range('post_date'), is_active: { $ne: false } })
        .select('id tweet_id platform posted_by content tweet_url engagement post_date analysis')
        .lean();
    const posts = new Map();
    grievances.forEach((g) => {
        const text = g.content?.full_text || g.content?.text || '';
        const metrics = metricsOf(g.engagement);
        const base = {
            _id: g.id || String(g._id),
            platform: g.platform || 'x',
            platform_post_id: String(g.tweet_id || g.id),
            url: g.tweet_url || null,
            author_name: g.posted_by?.display_name || null,
            author_handle: g.posted_by?.handle || null,
            author_followers: g.posted_by?.follower_count ?? null,
            verified: Boolean(g.posted_by?.is_verified),
            published_at: g.post_date || null,
            text,
            media: mediaOf(g.content?.media),
            post_type: 'original',
            metrics,
            engagement_total: total(metrics),
        };
        posts.set(`${base.platform}:${base.platform_post_id}`, mapPost(base, g.analysis || {}, subject));
    });

    const contents = await Content.find({ ...range('published_at') })
        .select('id platform content_id content_url text author author_handle published_at media engagement is_repost risk_level sentiment')
        .lean();
    const analyses = await Analysis.find({ content_id: { $in: contents.map((c) => c.id) } })
        .select('content_id sentiment risk_level language llm_analysis explanation')
        .lean();
    const byContent = new Map(analyses.map((x) => [x.content_id, x]));
    contents.forEach((c) => {
        const key = `${c.platform}:${c.content_id}`;
        if (posts.has(key)) return;
        const an = byContent.get(c.id);
        const a = an ? { ...(an.llm_analysis || {}), risk_level: an.risk_level, explanation: an.explanation, language_detected: an.llm_analysis?.language_detected } : {};
        const metrics = metricsOf(c.engagement);
        const base = {
            _id: c.id,
            platform: c.platform,
            platform_post_id: String(c.content_id),
            url: c.content_url || null,
            author_name: c.author || null,
            author_handle: c.author_handle || null,
            author_followers: null,
            verified: false,
            published_at: c.published_at || null,
            text: c.text || '',
            media: mediaOf(c.media),
            post_type: c.is_repost ? 'repost' : 'original',
            metrics: c.is_repost ? { likes: null, comments: null, shares: null, views: null } : metrics,
            engagement_total: c.is_repost ? 0 : total(metrics),
        };
        posts.set(key, mapPost(base, a, subject));
    });
    return [...posts.values()];
};

module.exports = { loadPosts, mapPost, slug };
