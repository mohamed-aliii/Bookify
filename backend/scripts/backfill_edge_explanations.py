"""
Backfill script to upgrade existing ConceptRelation and ConceptEdge rows
in data/bookify.db with rich, pedagogical, concept-bridging explanations.
"""
import sqlite3
import os
import sys

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "data", "bookify.db")
DB_PATH = os.path.abspath(DB_PATH)

EXPLANATIONS = {
    ("Language Models and Tokenization", "Autoregressive Language Models"): {
        "short": "Autoregressive language models specialize general LMs by restricting conditioning to past tokens, enabling open-ended generation while sharing tokenization mechanics.",
        "long": "The existing canonical 'Language Models and Tokenization' covers the broad class of statistical next-unit predictors and the token-level vocabulary encoding scheme. The proposed 'Autoregressive Language Models' specializes that concept by adding a directional/causal constraint — the next-token distribution is conditioned only on the prefix (left-to-right context), enabling unbounded open-ended generation. This is a stricter definition than the general LM category: bidirectional or masked LMs share the tokenization substrate but violate the autoregressive constraint. Directionality is existing -> proposed: mastering general LM/tokenization mechanics (vocabulary size, BPE vs. wordpiece, subword tradeoffs) is a prerequisite before the causal masking distinction of autoregressive models becomes meaningful.",
        "strength": 0.90
    },
    ("Autoregressive Language Models", "Self-Supervised Learning"): {
        "short": "Autoregressive prediction is the foundational self-supervised objective, turning raw text into training signals without manual labels.",
        "long": "Autoregressive language modeling is one of the premier algorithmic expressions of self-supervised learning. In an autoregressive framework, the prediction target for every token is simply the next token in the sequence, allowing the training process to extract supervision directly from raw, unannotated text corpora. Understanding how next-token prediction operates in autoregressive models provides the concrete mathematical mechanism necessary to grasp why self-supervised pre-training scales so effectively across billions of web documents without requiring human labeling.",
        "strength": 0.90
    },
    ("Self-Supervised Learning", "Scaling Laws for LLMs"): {
        "short": "Self-supervision provides the virtually boundless training data required for empirical scaling laws to hold across compute and parameters.",
        "long": "Self-supervised learning eliminates the economic and logistical bottleneck of human annotation, unlocking trillions of tokens of training data. Neural scaling laws (such as Chinchilla and Kaplan formulations) empirically quantify how cross-entropy loss predictably decreases as a power-law function of compute, model parameters, and dataset size. Understanding that self-supervision provides an endless data reservoir is a prerequisite to understanding why and how scaling laws govern model capacity and resource allocation in modern AI development.",
        "strength": 0.90
    },
    ("Scaling Laws for LLMs", "Foundation Models"): {
        "short": "Scaling laws established that large-scale pre-training produces predictable generalist capabilities, justifying the creation of foundation models.",
        "long": "Empirical scaling laws demonstrated that scaling up model parameters and compute results in continuous, predictable performance improvements and emergent reasoning capabilities. This theoretical and empirical proof justified the transition from training thousands of small, specialized models to investing massive compute into training large, generalist 'foundation models' that act as versatile bases for myriad downstream applications.",
        "strength": 0.90
    },
    ("Foundation Models", "Multimodal Models"): {
        "short": "Multimodal architectures project vision and audio into the pre-trained semantic space established by foundation models.",
        "long": "Multimodal models build directly upon foundation model architectures by projecting disparate sensory inputs—such as image patches, video frames, and audio spectrograms—into the same unified embedding space and transformer backbone. A student must first understand how single-modality foundation models encode abstract concepts and autoregressively generate tokens before learning how cross-attention and projection layers bind vision and speech into a multimodal reasoning engine.",
        "strength": 0.85
    },
    ("Foundation Models", "Model Adaptation Methods"): {
        "short": "Foundation models provide general knowledge, but require adaptation methods to perform specific tasks, adhere to schemas, and access private data.",
        "long": "Pre-trained foundation models possess vast general knowledge but lack the task-specific alignment, domain constraints, and private data access required for production applications. Model adaptation methods (prompt engineering, RAG, and finetuning) are the technical mechanisms used to bridge this gap. Understanding base foundation models—their capabilities, hallucinations, and frozen weights—is essential before selecting and executing the right adaptation strategy.",
        "strength": 0.90
    },
    ("Foundation Models", "AI Engineering Discipline"): {
        "short": "The rise of foundation models shifted software engineering from training models from scratch to system-level integration, steering, and evaluation.",
        "long": "Foundation models caused a paradigm shift in software development, creating the AI Engineering discipline. Rather than gathering custom datasets and training machine learning models from scratch, AI engineers compose, prompt, ground, and orchestrate pre-trained foundation models into resilient software systems. Understanding foundation model characteristics and failure modes is the foundational prerequisite for the entire discipline.",
        "strength": 0.90
    },
    ("Model Adaptation Methods", "Prompt Engineering"): {
        "short": "Prompt engineering is the lightest, zero-weight adaptation method, steering foundation models purely via in-context instruction.",
        "long": "Within the taxonomy of model adaptation, prompt engineering is the in-context approach that guides model behavior purely at inference time without modifying underlying weights. Understanding the broader adaptation landscape helps engineers recognize when prompt engineering is optimal for rapid iteration, and when context window limitations or latency overhead require transitioning to RAG or finetuning.",
        "strength": 0.85
    },
    ("Model Adaptation Methods", "Finetuning"): {
        "short": "Finetuning is the weight-updating adaptation method, modifying model parameters on custom datasets when in-context prompting is insufficient.",
        "long": "Finetuning represents the deepest layer of model adaptation, where model weights (or parameter-efficient adapter layers like LoRA) are modified using supervised task data. Situating finetuning within the adaptation taxonomy is critical for avoiding the common engineering pitfall of attempting costly finetuning before exhausting prompt engineering or RAG, and for understanding how weight updates differ from in-context conditioning.",
        "strength": 0.85
    },
    ("Model Adaptation Methods", "Evaluation Challenges for LLMs"): {
        "short": "Varying adaptation methods produce non-deterministic outputs, creating unique challenges for evaluating output quality and correctness.",
        "long": "Each model adaptation method alters model behavior in distinct, probabilistic ways, making traditional software and ML testing metrics (such as unit tests or fixed accuracy) insufficient. Understanding how prompts, context retrieval, and fine-tuning influence generative outputs is necessary to understand why evaluating LLMs requires specialized methodologies like LLM-as-a-judge, reference-free metrics, and systematic validation benchmarks.",
        "strength": 0.85
    },
    ("Prompt Engineering", "Retrieval-Augmented Generation (RAG)"): {
        "short": "RAG programmatically automates prompt engineering by dynamically injecting retrieved external passages into the model's prompt.",
        "long": "Retrieval-Augmented Generation (RAG) is an architectural extension of prompt engineering. Instead of manually packing knowledge into a prompt, a RAG pipeline programmatically queries an external vector store or search index and injects relevant context into the model's prompt template. Mastering prompt engineering is required to structure system prompts that force the LLM to adhere strictly to retrieved citations and suppress pre-trained hallucinations.",
        "strength": 0.88
    },
    ("AI Engineering Discipline", "Model-as-a-Service APIs"): {
        "short": "Model-as-a-Service APIs provide the scalable cloud infrastructure through which AI engineers access and orchestrate foundation models.",
        "long": "Model-as-a-Service (MaaS) APIs (such as OpenAI, Anthropic, and OpenRouter) are the primary infrastructure delivery mechanism for the AI engineering discipline. AI engineers rely on these hosted inference endpoints to build applications without managing GPU clusters. Understanding the developer's role in AI engineering is necessary to appreciate API abstractions, rate limits, latency trade-offs, and token cost economics.",
        "strength": 0.85
    },
    ("AI Engineering Discipline", "AI Application Planning"): {
        "short": "AI engineering requires distinct application planning to manage non-deterministic behavior, latency, and the last-mile path to production.",
        "long": "Unlike traditional software where logic is deterministic and reproducible, AI applications introduce probabilistic behaviors, latency variances, and token economics. AI application planning is the systematic process of defining user milestones, establishing fallback behaviors, and navigating the 'last-mile' gap between an impressive demo and a robust, reliable production system.",
        "strength": 0.85
    },
    ("AI Application Planning", "AI Product Defensibility"): {
        "short": "Application planning must anticipate foundational model improvements to build durable defensibility through proprietary data and workflows.",
        "long": "AI product defensibility is a strategic imperative in application planning. Because frontier foundation models improve rapidly with each release, simple 'wrapper' applications risk being rendered obsolete overnight. Effective planning must architect proprietary data flywheels, complex domain integrations, and defensible user workflows that retain value even as base models become more capable.",
        "strength": 0.85
    },
}

def main():
    if not os.path.exists(DB_PATH):
        print(f"Database not found at {DB_PATH}")
        sys.exit(1)

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    cr_updated = 0
    ce_updated = 0

    # 1. Update ConceptRelation
    for (src_name, tgt_name), expl in EXPLANATIONS.items():
        cur.execute(
            """
            UPDATE concept_relations
            SET explanation_short = ?,
                explanation_long = ?,
                strength = ?
            WHERE source_concept_id = (SELECT id FROM concepts WHERE canonical_name = ?)
              AND target_concept_id = (SELECT id FROM concepts WHERE canonical_name = ?)
            """,
            (expl["short"], expl["long"], expl["strength"], src_name, tgt_name)
        )
        if cur.rowcount > 0:
            cr_updated += cur.rowcount

    # 2. Update ConceptEdge
    for (src_name, tgt_name), expl in EXPLANATIONS.items():
        cur.execute(
            """
            UPDATE concept_edges
            SET explanation = ?,
                strength = ?
            WHERE source_point_id = (SELECT id FROM knowledge_points WHERE name = ?)
              AND target_point_id = (SELECT id FROM knowledge_points WHERE name = ?)
            """,
            (expl["long"], expl["strength"], src_name, tgt_name)
        )
        if cur.rowcount > 0:
            ce_updated += cur.rowcount

    conn.commit()
    conn.close()
    print(f"Successfully upgraded {cr_updated} ConceptRelations and {ce_updated} ConceptEdges with rich pedagogical explanations.")

if __name__ == "__main__":
    main()
