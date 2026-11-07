import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installRegister } from "./src/extension.ts";

export default function register(pi: ExtensionAPI): void {
	installRegister(pi);
}
