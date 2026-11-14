import { expect, it, vi } from "vite-plus/test";
import { htmlToText } from "../src/google/html";

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
  ["trailing generated newline in pre", "<p>x</p><pre>line<br></pre>", "x\nline"],
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
  // Split the real input stream inside an entity, independently of the producer's chunk size.
  vi.stubGlobal(
    "Response",
    class extends OriginalResponse {
      constructor(body?: BodyInit | null, init?: ResponseInit) {
        const stream = new OriginalResponse(body, init).body;
        super(
          stream?.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                const at = new TextDecoder().decode(chunk).indexOf("&thetasym;");
                if (at < 0) controller.enqueue(chunk);
                else {
                  controller.enqueue(chunk.subarray(0, at + 4));
                  controller.enqueue(chunk.subarray(at + 4));
                }
              },
            }),
          ),
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

it.each([
  [4000, 10000],
  // This smaller input gets its notice only through the converter's cut flag.
  [500, 1100],
])(
  "bounds expanded quote prefixes while converting %i nested quotes and %i lines",
  async (depth, lines) => {
    const html =
      "<blockquote>".repeat(depth) + "line<br>".repeat(lines) + "</blockquote>".repeat(depth);
    const text = await htmlToText(html);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(text.length).toBeLessThanOrEqual(1000000);
    expect(
      text.endsWith(
        "\n[The rest of this message was left out: it is longer than 1,000,000 characters.]",
      ),
    ).toBe(true);
  },
  20_000,
);

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

it("keeps the omission notice when an unclosed link reaches the text bound", async () => {
  const html = "x".repeat(999990) + `<a href="https://example.com/${"a".repeat(100)}">link`;
  const text = await htmlToText(html);
  const notice =
    "\n[The rest of this message was left out: it is longer than 1,000,000 characters.]";
  expect(
    text === "x".repeat(1000000 - notice.length) + notice,
    "The unclosed link keeps the bounded prefix and omission notice",
  ).toBe(true);
});

it("awaits the parser input's completion when text reaches the bound", async () => {
  const OriginalResponse = Response;
  const ended = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  vi.stubGlobal(
    "Response",
    class extends OriginalResponse {
      constructor(body?: BodyInit | null, init?: ResponseInit) {
        const reader = new OriginalResponse(body, init).body!.getReader();
        super(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              const chunk = await reader.read();
              if (chunk.done) {
                ended.resolve();
                await release.promise;
                controller.close();
              } else controller.enqueue(chunk.value);
            },
            cancel(reason) {
              return reader.cancel(reason);
            },
          }),
          init,
        );
      }
    },
  );
  const conversion = htmlToText("<blockquote>".repeat(500) + "x<br>".repeat(2000));
  try {
    await Promise.race([
      ended.promise,
      conversion.then(() => {
        throw new Error("Conversion returned before its input finished");
      }),
    ]);
    let settled = false;
    void conversion.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    expect(
      (await conversion).endsWith(
        "\n[The rest of this message was left out: it is longer than 1,000,000 characters.]",
      ),
    ).toBe(true);
  } finally {
    release.resolve();
    await conversion.catch(() => {});
    vi.unstubAllGlobals();
  }
});
