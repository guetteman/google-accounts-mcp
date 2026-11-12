import { expect, it, vi } from "vite-plus/test";
import { decodeEntities, htmlToText } from "../src/google/html";

// This boundary uses workerd's HTMLRewriter, including its handling of broken markup and chunks.
it.each([
  ["tags and comments", "<div>Hello <b>reader</b><!-- secret --></div>", "Hello reader"],
  [
    "non-body text",
    "<title>title</title><style>style</style><script>script</script><p>Body</p>",
    "Body",
  ],
  [
    "numeric entities",
    "&#241; &#x1F642; &#X1F642; &apos; &unknown; &#99999999; &#xD800;",
    "ñ 🙂 🙂 ' &unknown; &#99999999; &#xD800;",
  ],
  [
    "HTML 4 names",
    "&nbsp;&eacute; &Alpha; &thetasym; &euro; &rArr; &there4; &spades; &OElig; &frac12;",
    "é Α ϑ € ⇒ ∴ ♠ Œ ½",
  ],
  ["block endings and br", "<div>One<br>Two</div><p>Three</p><hr>Four", "One\nTwo\nThree\nFour"],
  [
    "link addresses",
    '<a href="https://example.com/?a=1&amp;b=2">Menu</a>',
    "Menu (https://example.com/?a=1&b=2)",
  ],
  ["mail links", '<a href="mailto:sam@example.com">Sam</a>', "Sam (mailto:sam@example.com)"],
  [
    "links already named by address",
    '<a href="http://example.com">http://example.com</a>',
    "http://example.com",
  ],
  ["empty links", '<a href="https://example.com"></a>', "https://example.com"],
  [
    "relative and non-HTTP link addresses",
    '<a href="javascript:alert(1)">Keep text</a><a href="/relative"> here</a>',
    "Keep text (javascript:alert(1)) here (/relative)",
  ],
  [
    "nested quotes",
    "<blockquote><p>First</p><blockquote>Second<br>Third</blockquote>Fourth</blockquote>",
    "> First\n> > Second\n> > Third\n> Fourth",
  ],
  ["lists", "<ul><li>One</li><li>Two</li></ul>", "- One\n- Two"],
  [
    "inline images",
    '<p>A<img src="cid:one" alt="caf&eacute; &amp; &#241;">B<img src="cid:two">C<img src="https://example.com/pixel"></p>',
    "A[image: café & ñ]B[image]C",
  ],
  ["collapsed whitespace", "  Hello   reader\n\n\n\t here   ", "Hello reader here"],
  ["blank lines", "<p>One</p><br><br><br><p>Two</p>", "One\n\nTwo"],
  [
    "preformatted whitespace",
    "<p>Start</p><pre>one  two\n\n\n  three\tfour</pre><p>End</p>",
    "Start\none  two\n\n\n  three\tfour\nEnd",
  ],
  [
    "unclosed a",
    '<div><a href="https://example.com">link</div><p>After</p>',
    "link (https://example.com)\nAfter",
  ],
  ["unclosed div", "<section><div>Body</section><p>After</p>", "Body\nAfter"],
  ["unclosed blockquote", "<section><blockquote>Quoted</section><p>After</p>", "> Quoted\nAfter"],
  ["preformatted at edges", "<pre>  code \n\n   tail\t  </pre>", "  code \n\n   tail\t  "],
  ["whitespace-only pre", "<pre>   </pre>", "   "],
  [
    "table cell boundaries",
    "<table><tr><th>Total</th><td>$15.00</td></tr></table>",
    "Total $15.00",
  ],
  [
    "nested table cells",
    "<table><tr><td>one<table><tr><td>two</td><td>three</td></tr></table>four</td><td>five</td></tr></table>",
    "one\ntwo three\nfour five",
  ],
  [
    "table cell whitespace",
    "<table><tr><td>Total </td><td> $15.00 </td></tr><tr><td> Tax</td><td>$1.00</td></tr></table>",
    "Total $15.00\nTax $1.00",
  ],
  [
    "self-closing SVG link",
    '<p>a</p><svg><a href="https://x.example/"/></svg><p>after</p>',
    "a\nhttps://x.example/\nafter",
  ],
  [
    "self-closing MathML link",
    '<p>a</p><math><a href="https://x.example/"/></math><p>after</p>',
    "a\nhttps://x.example/\nafter",
  ],
  ["self-closing SVG block", "<p>a</p><svg><section/></svg><p>after</p>", "a\nafter"],
  ["self-closing MathML block", "<p>a</p><math><section/></math><p>after</p>", "a\nafter"],
  ["self-closing hidden element", "<p>a</p><svg><style/></svg><p>after</p>", "a\nafter"],
  [
    "fragmented link label",
    '<a href="https://example.com/item">  <b>https://</b>example.com/<i>item</i>  </a>',
    "https://example.com/item",
  ],
  ["table cells without end tags", "<table><tr><td>one<td>two</table>", "one two"],
  [
    "padded link addresses",
    '<a href=" https://other.example/login ">https://bank.example</a>',
    "https://bank.example (https://other.example/login)",
  ],
  [
    "protocol-relative link addresses",
    '<a href="//other.example/login">https://bank.example</a>',
    "https://bank.example (//other.example/login)",
  ],
  [
    "fragment and empty links",
    '<a href="#section">Section</a> <a href="  ">Empty</a> <a>No href</a>',
    "Section Empty No href",
  ],
])("converts %s", async (_rule, html, expected) => {
  expect(await htmlToText(html)).toBe(expected);
});

it("decodes an entity even when HTMLRewriter splits its text node into chunks", async () => {
  const OriginalResponse = Response;
  // A real streaming Response makes the parser split one text node in the middle of an entity.
  // A string-backed Response arrives in one chunk, however long the string is.
  vi.stubGlobal(
    "Response",
    class extends OriginalResponse {
      constructor(body?: BodyInit | null, init?: ResponseInit) {
        if (typeof body !== "string") {
          super(body, init);
          return;
        }
        const at = body.indexOf("&thetasym;") + 4;
        const parts = [body.slice(0, at), body.slice(at)];
        let next = 0;
        super(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (next < parts.length) controller.enqueue(new TextEncoder().encode(parts[next++]!));
              else controller.close();
            },
          }),
          init,
        );
      }
    },
  );
  try {
    expect(await htmlToText("<p>Before &thetasym;after</p>")).toBe("Before ϑafter");
  } finally {
    vi.unstubAllGlobals();
  }
});

it("uses the same complete entity decoder for snippets", () => {
  expect(decodeEntities("&nbsp;&eacute; &Alpha; &#x1f642; &apos; &unknown;")).toBe(
    "\u00a0é Α 🙂 ' &unknown;",
  );
});

it("converts 2 MB of table rows with links within twenty seconds", async () => {
  const row =
    '<tr><td class="item"><a href="https://example.com/item">Item</a></td><td>$15.00</td></tr>';
  const count = Math.ceil((2 * 1024 * 1024) / row.length);
  const html = `<table>${row.repeat(count)}</table>`;
  const text = await htmlToText(html);
  // Yield a task so synchronous parser callbacks cannot bypass the elapsed test timeout
  // by resolving the conversion promise before the timeout callback can run.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const expected = Array(count).fill("Item (https://example.com/item) $15.00").join("\n");
  expect(text === expected, "Every table row is converted in order").toBe(true);
}, 20_000);

it("bounds expanded quote prefixes while converting 4000 nested quotes and 10000 lines", async () => {
  const html =
    "<blockquote>".repeat(4000) + "line<br>".repeat(10000) + "</blockquote>".repeat(4000);
  const text = await htmlToText(html);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(text.length).toBeLessThanOrEqual(1000000);
  expect(
    text.endsWith(
      "\n[The rest of this message was left out: it is longer than 1,000,000 characters.]",
    ),
  ).toBe(true);
}, 20_000);

it("stops parsing at the text bound before an unparseable tail", async () => {
  const html =
    "<blockquote>".repeat(500) +
    "x<br>".repeat(1100) +
    "</blockquote>".repeat(500) +
    "<tr><td>".repeat(20000);
  const text = await htmlToText(html);
  expect(text.length).toBeLessThanOrEqual(1000000);
  expect(
    text.endsWith(
      "\n[The rest of this message was left out: it is longer than 1,000,000 characters.]",
    ),
  ).toBe(true);
});
