// P17-T02: JSON for a <script type="application/ld+json"> block cannot close the block.
const { jsonForScript } = require("../../src/utils/jsonLd");

describe("jsonForScript", () => {
  test("a title that tries to close the script block stays inside it", () => {
    const text = jsonForScript({ name: "</script><script>alert(1)</script>" });
    expect(text.includes("<")).toBe(false);
    expect(text.includes(">")).toBe(false);
    expect(JSON.parse(text).name).toBe("</script><script>alert(1)</script>"); // same data for a JSON parser
  });

  test("ampersands and the JavaScript line separators are escaped; plain data is unchanged", () => {
    const text = jsonForScript({ a: "Tom & Jerry\u2028\u2029" });
    expect(text.includes("&")).toBe(false);
    expect(text.includes("\u2028")).toBe(false);
    expect(text.includes("\u2029")).toBe(false);
    expect(JSON.parse(text).a).toBe("Tom & Jerry\u2028\u2029");
    expect(jsonForScript({ n: 1, ok: true })).toBe('{"n":1,"ok":true}');
  });
});
