import {
    debounce,
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
    PluginField,
    WidgetType
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { tokenClassNodeProp } from "@codemirror/stream-parser";

import Processor from "./processor";
import { RangeSetBuilder, Range } from "@codemirror/rangeset";
import {
    StateEffect,
    StateField,
    Transaction,
    StateEffectType,
    SelectionRange,
    ChangeSet
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
        //https://gist.github.com/nothingislost/faa89aa723254883d37f45fd16162337
        type TokenSpec = {
            from: number;
            to: number;
            loc: { from: number; to: number };
            value: string;
            index: number;
            type: "replace";
        };

        class StatefulDecorationSet {
            editor: EditorView;
            cache: { [cls: string]: Decoration } = Object.create(null);

            constructor(editor: EditorView) {
                this.editor = editor;
            }

            async compute(tokens: TokenSpec[]) {
                const replace: Range<Decoration>[] = [];
                for (let token of tokens) {
                    let deco = this.cache[token.value];
                    if (!deco) {
                        deco = this.cache[token.value] = Decoration.replace({
                            inclusive: true,
                            loc: token.loc
                        });
                    }
                    replace.push(deco.range(token.from, token.to));
                }
                return Decoration.set(replace, true);
            }

            async updateDecos(tokens: TokenSpec[]): Promise<void> {
                const replacers = await this.compute(tokens);
                // if our compute function returned nothing and the state field still has decorations, clear them out
                if (replace || this.editor.state.field(field).size) {
                    this.editor.dispatch({
                        effects: [replace.of(replacers ?? Decoration.none)]
                    });
                }
            }
        }

        const plugin = ViewPlugin.fromClass(
            class {
                manager: StatefulDecorationSet;
                decorations: DecorationSet;

                constructor(view: EditorView) {
                    this.manager = new StatefulDecorationSet(view);
                    this.decorations = this.build(view);
                }

                update(update: ViewUpdate) {
                    if (
                        update.docChanged ||
                        update.viewportChanged ||
                        update.selectionSet
                    ) {
                        this.decorations = this.build(update.view);
                    }
                }

                destroy() {}

                build(view: EditorView) {
                    const targetElements: TokenSpec[] = [];
                    const builder = new RangeSetBuilder<Decoration>();
                    for (let { from, to } of view.visibleRanges) {
                        const tree = syntaxTree(view.state);
                        tree.iterate({
                            from,
                            to,
                            enter: (type, from, to) => {
                                const tokenProps =
                                    type.prop(tokenClassNodeProp);

                                const props = new Set(tokenProps?.split(" "));
                                if (
                                    props.has("hmd-codeblock") &&
                                    !props.has("formatting-code-block")
                                )
                                    return;
                                const original = view.state.doc.sliceString(
                                    from,
                                    to
                                );

                                //TODO: You will probably need to identify block types to determine from and to values to apply mark.

                                if (!Processor.END_RE.test(original)) return;
                                const parsed = Processor.parse(original) ?? [];

                                for (const item of parsed) {
                                    const { attributes, text } = item;
                                    const end =
                                        original.indexOf(text) + text.length;
                                    const deco = Decoration.mark({
                                        inclusive: true,
                                        attributes:
                                            Object.fromEntries(attributes)
                                    });
                                    builder.add(from, end, deco);

                                    const match = original
                                        .trim()
                                        .match(
                                            new RegExp(
                                                `\\{\\s?${text}\s?\\}$`,
                                                "m"
                                            )
                                        );
                                    targetElements.push({
                                        type: "replace",
                                        from: from + match.index - 1,
                                        to:
                                            from +
                                            match.index +
                                            match[0].length,
                                        loc: { from, to: end },
                                        value: match[0],
                                        index: match.index
                                    });
                                }
                            }
                        });
                    }
                    this.manager.updateDecos(targetElements);
                    return builder.finish();
                }
            },
            {
                decorations: (v) => v.decorations
            }
        );

        ////////////////
        // Utility Code
        ////////////////

        const replace = StateEffect.define<DecorationSet>();
        const field = StateField.define<DecorationSet>({
            create(): DecorationSet {
                return Decoration.none;
            },
            update(deco, tr): DecorationSet {
                return tr.effects.reduce((deco, effect) => {
                    if (effect.is(replace))
                        return effect.value.update({
                            filter: (_, __, decoration) => {
                                return !rangesInclude(
                                    tr.newSelection.ranges,
                                    decoration.spec.loc.from,
                                    decoration.spec.loc.to
                                );
                            }
                        });
                    return deco;
                }, deco.map(tr.changes));
            },
            provide: (field) => EditorView.decorations.from(field)
        });

        return [field, plugin];
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

const rangesInclude = (
    ranges: readonly SelectionRange[],
    from: number,
    to: number
) => {
    for (const range of ranges) {
        const { from: rFrom, to: rTo } = range;
        if (rFrom >= from && rFrom <= to) return true;
        if (rTo >= from && rTo <= to) return true;
        if (rFrom < from && rTo > to) return true;
    }
    return false;
};
