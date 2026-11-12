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
    "unsafe link schemes",
    '<a href="javascript:alert(1)">Keep text</a><a href="/relative"> here</a>',
    "Keep text here",
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
