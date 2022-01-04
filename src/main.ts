import {
    editorEditorField,
    MarkdownPostProcessorContext,
    Plugin,
    TFile
} from "obsidian";
import {
    EditorView,
    Decoration,
    DecorationSet,
    ViewUpdate,
    ViewPlugin,
    PluginField
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { tokenClassNodeProp } from "@codemirror/stream-parser";

import Processor from "./processor";
import { RangeSetBuilder } from "@codemirror/rangeset";
import {
    EditorState,
    StateEffect,
    StateField,
    Transaction,
    Prec,
    TransactionSpec,
    Facet,
    SelectionRange
} from "@codemirror/state";

type ReplaceEffect = { from: number; to: number; text: string };

export default class MarkdownAttributes extends Plugin {
    parsing: Map<MarkdownPostProcessorContext, string> = new Map();
    async onload(): Promise<void> {
        console.log(`Markdown Attributes v${this.manifest.version} loaded.`);

        this.registerMarkdownPostProcessor(this.postprocessor.bind(this));

        this.registerEditorExtension(this.state());
    }

    state() {
        const DecorationField = PluginField.define<DecorationSet>();
        const decorator = ViewPlugin.fromClass(
            class {
                decorations: DecorationSet;
                constructor(view: EditorView) {
                    this.decorations = this.build(view);
                }
                update(update: ViewUpdate) {
                    if (update.docChanged || update.viewportChanged) {
                        this.decorations = this.build(update.view);
                    }
                }

                build(view: EditorView) {
                    let builder = new RangeSetBuilder<Decoration>();
                    for (let { from, to } of view.visibleRanges) {
                        try {
                            // syntaxTree gives us access to the tokens generated by the markdown parser
                            // here we iterate over the visible text and evaluate each token, sequentially.
                            const tree = syntaxTree(view.state);
                            tree.iterate({
                                from,
                                to,
                                enter: (type, from, to) => {
                                    // To access the parsed tokens, we need to use a NodeProp.
                                    // Obsidian exports their inline token NodeProp, tokenClassNodeProp, as part of their
                                    // custom stream-parser package. See the readme for more details.

                                    const tokenProps =
                                        type.prop(tokenClassNodeProp);
                                    const props = new Set(
                                        tokenProps?.split(" ")
                                    );

                                    if (props.has("hmd-codeblock")) return;
                                    const original = view.state.doc.sliceString(
                                        from,
                                        to
                                    );

                                    if (!Processor.END_RE.test(original))
                                        return;
                                    const parsed =
                                        Processor.parse(original) ?? [];

                                    for (const item of parsed) {
                                        const { attributes } = item;

                                        const deco = Decoration.mark({
                                            attributes:
                                                Object.fromEntries(attributes)
                                        });

                                        builder.add(from, to, deco);
                                    }
                                }
                            });
                        } catch (err) {
                            // cm6 will silently unload extensions when they crash
                            // this try/catch will provide details when crashes occur
                            console.error(
                                "Custom CM6 view plugin failure",
                                err
                            );
                            // make to to throw because if you don't, you'll block
                            // the auto unload and destabilize the editor
                            throw err;
                        }
                    }
                    return builder.finish();
                }
            },
            {
                decorations: (v) => v.decorations,
                provide: DecorationField.from((v) => v.decorations)
            }
        );

        const ReplacerField = PluginField.define<DecorationSet>();
        const replacer = ViewPlugin.fromClass(
            class {
                decorations: DecorationSet;
                constructor(view: EditorView) {
                    this.decorations = this.build(view);
                }
                update(update: ViewUpdate) {
                    if (update.docChanged || update.viewportChanged) {
                        this.decorations = this.build(update.view);
                    } else if (update.selectionSet) {
                        this.decorations = this.build(
                            update.view,
                            update.transactions
                        );
                    }
                }

                build(
                    view: EditorView,
                    transactions: readonly Transaction[] = []
                ) {
                    const decorations: [
                        from: number,
                        to: number,
                        value: Decoration
                    ][] = [];
                    for (let { from, to } of view.visibleRanges) {
                        try {
                            // syntaxTree gives us access to the tokens generated by the markdown parser
                            // here we iterate over the visible text and evaluate each token, sequentially.
                            const tree = syntaxTree(view.state);
                            tree.iterate({
                                from,
                                to,
                                enter: (type, from, to) => {
                                    // To access the parsed tokens, we need to use a NodeProp.
                                    // Obsidian exports their inline token NodeProp, tokenClassNodeProp, as part of their
                                    // custom stream-parser package. See the readme for more details.

                                    const tokenProps =
                                        type.prop(tokenClassNodeProp);
                                    const props = new Set(
                                        tokenProps?.split(" ")
                                    );

                                    if (props.has("hmd-codeblock")) return;

                                    const original = view.state.doc.sliceString(
                                        from,
                                        to
                                    );

                                    if (!Processor.END_RE.test(original))
                                        return;
                                    if (
                                        rangesInclude(
                                            transactions
                                                .map((t) => t.selection.ranges)
                                                .flat(),
                                            from,
                                            to
                                        )
                                    ) {
                                        return;
                                    }
                                    const parsed =
                                        Processor.parse(original) ?? [];

                                    for (const item of parsed) {
                                        const { text } = item;

                                        const match = original.match(
                                            new RegExp(`\\{\\s?${text}\s?\\}`)
                                        );
                                        const replace = Decoration.replace({
                                            inclusive: true
                                        });

                                        decorations.push([
                                            from + match.index - 1,
                                            from +
                                                match.index +
                                                match[0].length,
                                            replace
                                        ]);
                                    }
                                }
                            });
                        } catch (err) {
                            // cm6 will silently unload extensions when they crash
                            // this try/catch will provide details when crashes occur
                            console.error(
                                "Custom CM6 view plugin failure",
                                err
                            );
                            // make to to throw because if you don't, you'll block
                            // the auto unload and destabilize the editor
                            throw err;
                        }
                    }
                    let builder = new RangeSetBuilder<Decoration>();
                    decorations
                        .sort((a, b) => a[0] - b[0])
                        .forEach((set) => builder.add(...set));
                    return builder.finish();
                }
            },
            {
                decorations: (v) => v.decorations,
                provide: ReplacerField.from((v) => v.decorations)
            }
        );
        return [replacer, decorator];
    }

    async postprocessor(
        topElement: HTMLElement,
        ctx: MarkdownPostProcessorContext
    ) {
        const child = topElement.firstElementChild;
        if (!child) return;
        let str: string;

        /** Code blocks have to be handled separately because Obsidian does not
         *  include any text past the language.
         *
         *  Unfortunately this also means that changes to the code block attributes
         *  require reloading the note to take effect because they do not trigger the postprocessor.
         */
        if (child instanceof HTMLPreElement) {
            /** If getSectionInfo returns null, stop processing. */
            if (!ctx.getSectionInfo(topElement)) return;

            /** Pull the Section data. */
            const { lineStart } = ctx.getSectionInfo(topElement);

            const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
            if (!(file instanceof TFile)) return;
            const text = await this.app.vault.cachedRead(file);

            /** Get the source for this element. Only look at the top line for code blocks. */
            let source = text.split("\n").slice(lineStart, lineStart + 1);
            str = source.join("\n");
            /** Test if the element contains attributes. */
            if (!Processor.BASE_RE.test(str)) return;

            /** Pull the matched string and add it to the child so the Processor catches it. */
            let [attribute_string] = str.match(Processor.BASE_RE) ?? [];
            child.prepend(new Text(attribute_string));
        }

        /**
         * Table elements and Mathjax elements should check the next line in the source to see if it is a single block attribute,
         * because those block attributes are not applied to the table.
         */
        if (
            child instanceof HTMLTableElement ||
            (child.hasClass("math") && child.hasClass("math-block")) ||
            child.hasClass("callout")
        ) {
            console.log("🚀 ~ file: main.ts ~ line 58 ~ child", child);
            if (!ctx.getSectionInfo(topElement)) return;

            /** Pull the Section data. */
            const { text, lineEnd } = ctx.getSectionInfo(topElement);
            console.log(
                "🚀 ~ file: main.ts ~ line 63 ~ text",
                text.split("\n"),
                lineEnd
            );

            /** Callouts include the block level attribute */
            const adjustment = child.hasClass("callout") ? 0 : 1;

            /** Get the source for this element. */
            let source = (
                text
                    .split("\n")
                    .slice(lineEnd + adjustment, lineEnd + adjustment + 1) ?? []
            ).shift();

            /** Test if the element contains attributes. */
            if (
                source &&
                source.length &&
                Processor.ONLY_RE.test(source.trim())
            ) {
                /** Pull the matched string and add it to the child so the Processor catches it. */
                let [attribute_string] = source.match(Processor.ONLY_RE) ?? [];
                child.prepend(new Text(attribute_string));

                str = topElement.innerText;
            }
        }

        /**
         * If the element is a <p> and the text is *only* an attribute, it was used as a block attribute
         * and should be removed.
         */
        if (child instanceof HTMLParagraphElement && !child.childElementCount) {
            if (Processor.ONLY_RE.test(child.innerText.trim())) {
                child.detach();
                return;
            }
        }

        /** Test if the element contains attributes. */
        if (!Processor.BASE_RE.test(str ?? topElement.innerText)) return;

        /** Parse the element using the Processor. */
        if (!(child instanceof HTMLElement)) return;
        Processor.parse(child);
    }

    async onunload() {
        console.log("Markdown Attributes unloaded");
    }
}

const rangesInclude = (ranges: SelectionRange[], from: number, to: number) => {
    for (const range of ranges) {
        const { from: rFrom, to: rTo } = range;
        if (rFrom >= from && rFrom <= to) return true;
        if (rTo >= from && rTo <= to) return true;
        if (rFrom < from && rTo > to) return true;
    }
    return false;
};
