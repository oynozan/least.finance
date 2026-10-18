import Link from "next/link";

export default function NotFound() {
    return (
        <main className="grid min-h-[60vh] place-items-center px-4 text-center">
            <div>
                <p className="text-[17px]">That page doesn&apos;t exist.</p>
                <Link href="/" className="mt-5 inline-block rounded-full bg-pill px-6 py-3 text-[15px]">
                    Back to Least
                </Link>
            </div>
        </main>
    );
}
