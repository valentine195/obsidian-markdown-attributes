import { Pos } from "obsidian";
import type { Line } from "@codemirror/text";

type ElementWithAttributes = {
    element?: Element;
    attributes: [string, string][];
    text: string;
};

export default class Processor {
    static BASE_RE = /\{\:?[ ]*([^\}\n ][^\}\n]*)[ ]*\}/;
    static ONLY_RE = /^\{\:?[ ]*([^\}\n ][^\}\n]*)[ ]*\}$/;
    static END_RE = /\{\:?[ ]*([^\}\n ][^\}\n]*)[ ]*\}$/m;
    static BLOCK_RE = /\n[ ]*\{\:?[ ]*([^\}\n ][^\}\n]*)[ ]*\}[ ]*$/;

    constructor() {}

    static parse(el: HTMLElement): ElementWithAttributes[];
    static parse(el: string): ElementWithAttributes[];
    static parse(el: string | HTMLElement) {
        if (typeof el == "string") {
            return new Processor().parseLine(el);
        } else {
            return new Processor().recurseAndParseElements(el);
        }
    }

    parseLine(text: string) {
        const elements: ElementWithAttributes[] = [];
        // Parse out the attribute string.
        let attribute_strings = text.matchAll(
            new RegExp(Processor.END_RE.source, "gm")
        );

        for (const [_, match] of attribute_strings) {
            elements.push({
                attributes: this.getAttrs(match),
                text: match
            });
        }
        return elements;
    }

    /**
     * Traverses an elements child nodes and returns the text content.
     * @param el HTML element to get text nodes of.
     * @returns Top level text of the element.
     */
    private getTopLevelText(el: Element) {
        const texts = [];

        for (let child of Array.from(el.childNodes)) {
            if (child.nodeType == Node.TEXT_NODE) {
                texts.push((child as CharacterData).data);
            }
        }

        return texts.join("");
    }

    /**
     * Parse a string and return the [key, value] attribute pairs.
     * @param str String to pull attributes from.
     * @returns {[string, string]} Array of [key, value] attribute pairs.
     */
    private getAttrs(str: string) {
        const trys = (str ?? "")
            // Split the string at spaces that are *not* between quotes.
            .split(/\s(?=(?:[^'"`]*(['"`])[^'"`]*\1)*[^'"`]*$)/)
            // Trim the resulting strings.
            .map((t) => t && t.trim())
            // Remove any strings that are undefined, zero length, or just a quote character.
            .filter((t) => t && t !== '"' && t !== "'" && t.length);

        if (!trys || !trys.length) return;

        // These characters are not allowed to be inside an attribute key.
        const allowedKeyChars = /[^\t\n\f />"'=]/;

        // {: data=value }
        const keySeparator = "=";
        // { .class }
        const classChar = ".";
        // { #id }
        // currently not allowed due to Obsidian tag
        // TODO: Figure out a workaround.
        /* const idChar = "#"; */
        const attrs: Array<[string, string]> = [];

        for (let pair of trys) {
            if (!pair || !pair.length) continue;

            //#id
            /* if (pair.charAt(0) === idChar) {
                attrs.push(["id", pair.slice(1)]);
                continue;
            } */

            // .class
            if (pair.charAt(0) === classChar) {
                attrs.push(["class", pair.slice(1)]);
                continue;
            }

            // data=value
            if (
                new RegExp(keySeparator).test(pair) &&
                allowedKeyChars.test(pair.slice(0, pair.indexOf(keySeparator)))
            ) {
                attrs.push([...pair.split(keySeparator, 2)] as [
                    string,
                    string
                ]);
                continue;
            }

            // checked
            attrs.push([pair, null]);
        }
        return attrs;
    }

    /**
     *
     * @param el HTML element to parse.
     * @returns {ElementWithAttributes} Element, attributes to apply, original matched text.
     */
    private recurseAndParseElements(el: HTMLElement): ElementWithAttributes[] {
        const elements: ElementWithAttributes[] = [];

        // Text content of this node and *not* the children.
        const text = this.getTopLevelText(el);

        if (Processor.BLOCK_RE.test(text)) {
            // Attributes should apply to the whole block.

            let element = el;
            if (
                el instanceof HTMLLIElement ||
                el?.parentElement instanceof HTMLQuoteElement ||
                el?.hasClass("callout")
            ) {
                // Need to apply attributes to containing UL if HTMLLIElement has a block attribute
                element = el.parentElement;
            }

            let [original, attribute_string] =
                text.match(Processor.BLOCK_RE) ?? [];
            const toAdd = {
                element,
                attributes: this.getAttrs(attribute_string),
                text: attribute_string
            };

            elements.push(toAdd);
            el.innerHTML = this.tryToReplace(
                toAdd.element,
                el.innerHTML,
                toAdd.attributes,
                original
            );
            /* el.innerHTML = el.innerHTML.replace(original, ""); */

            //rerun parser if LI element to get inlines
            if (el instanceof HTMLLIElement) {
                elements.push(...this.recurseAndParseElements(el));
            }
        } else if (Processor.BASE_RE.test(text)) {
            // Attributes are inline.
            // Get the text nodes that contains the attribute string.
            let textNode = Array.from(el.childNodes).find(
                (node) =>
                    node.nodeType == Node.TEXT_NODE &&
                    Processor.BASE_RE.test(text)
            );

            // Find the HTML element that is the previous sibling of the text node.
            // textNode.previousSibling could return another text node.
            // previousElementSibling does not existing on a text node.
            let sibling =
                Array.from(el.children).find(
                    (node) => node.nextSibling == textNode
                ) ?? el;

            // Collapsible elements are a special case due to the collapse handle.
            if (sibling && sibling.hasClass("collapse-indicator")) {
                sibling = sibling.parentElement;
            }

            if (sibling && sibling instanceof HTMLBRElement) {
                sibling = sibling.parentElement;
            }

            // Parse out the attribute string.
            let [original, attribute_string] =
                text.match(Processor.BASE_RE) ?? [];

            const toAdd = {
                element: sibling,
                attributes: this.getAttrs(attribute_string),
                text: attribute_string
            };

            elements.push(toAdd);

            // Remove the original attribute string from the text content.
            textNode.textContent = this.tryToReplace(
                toAdd.element,
                textNode.textContent,
                toAdd.attributes,
                original
            );
            /* textNode.textContent = textNode.textContent.replace(original, ""); */
        }

        // Recursively find all attributes from the children of this element.

        for (let child of Array.from(el.children)) {
            if (!(child instanceof HTMLElement)) continue;
            if (
                child instanceof HTMLPreElement ||
                child.tagName.toLowerCase() === "code"
            )
                continue;
            elements.push(...this.recurseAndParseElements(child));
        }

        return elements;
    }
    tryToReplace(
        element: Element,
        content: string,
        attributes: [string, string][],
        original: string
    ) {
        if (!attributes || !attributes.length) {
            return content;
        }

        for (let [key, value] of attributes) {
            if (!key) continue;
            if (value) value = value.replace(/("|')/g, "");
            try {
                if (key === "class") {
                    element.addClasses(value.split(" "));
                } else if (!value) {
                    element.setAttr(key, true);
                } else {
                    element.setAttr(key, value);
                }
            } catch (e) {
                console.log(
                    `Markdown Attributes: ${key} is not a valid attribute.`
                );
                return content;
            }
        }

        return content.replace(original, "");
    }
}
