import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { createZip, downloadBlob, geometriesToBinaryStl } from './export';
import {
    BoardPart,
    MAX_CORNER_CHAMFER,
    MAX_EDGE_FILLET,
    MAX_HOLE_FILLET,
    MIN_PART_SIZE,
    SCREW_HOLE_DIAMETER,
    buildBoardLayout,
    buildPartGeometry
} from './pegboard';

const SkadisGenerator = () => {
    const [width, setWidth] = useState(280);
    const [height, setHeight] = useState(280);
    const [thickness, setThickness] = useState(5);
    const [withMountingHoles, setWithMountingHoles] = useState(true);
    const [edgeFillet, setEdgeFillet] = useState(2);
    const [holeFillet, setHoleFillet] = useState(2);
    const [cornerHoleChamfer, setCornerHoleChamfer] = useState(2);
    const [splitBoard, setSplitBoard] = useState(false);
    const [maxPartWidth, setMaxPartWidth] = useState(240);
    const [maxPartHeight, setMaxPartHeight] = useState(240);
    const [clearance, setClearance] = useState(0.2);
    const [exportMode, setExportMode] = useState<'zip' | 'single'>('zip');
    const mountRef = useRef<HTMLDivElement>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const controlsRef = useRef<OrbitControls | null>(null);

    const COUNTERSINK_DEPTH = 10;

    const layout = useMemo(
        () =>
            buildBoardLayout({
                width,
                height,
                withMountingHoles,
                split: splitBoard,
                maxPartWidth,
                maxPartHeight,
                clearance
            }),
        [width, height, withMountingHoles, splitBoard, maxPartWidth, maxPartHeight, clearance]
    );
    const maxFilletForThickness = thickness / 2;
    const filletOptions = useMemo(
        () => ({
            thickness,
            edgeFillet: Math.min(edgeFillet, maxFilletForThickness),
            holeFillet: Math.min(holeFillet, maxFilletForThickness),
            cornerHoleChamfer
        }),
        [thickness, edgeFillet, holeFillet, cornerHoleChamfer, maxFilletForThickness]
    );
    const largestPart = layout.parts.reduce(
        (acc, p) => ({
            w: Math.max(acc.w, p.bbox.maxX - p.bbox.minX),
            h: Math.max(acc.h, p.bbox.maxY - p.bbox.minY)
        }),
        { w: 0, h: 0 }
    );

    useEffect(() => {
        if (!mountRef.current) return;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0xf5f5f5);
        sceneRef.current = scene;

        const camera = new THREE.PerspectiveCamera(
            50,
            mountRef.current.clientWidth / mountRef.current.clientHeight,
            0.1,
            3000
        );
        const maxDim = Math.max(width, height);
        camera.position.set(maxDim * 0.7, maxDim * 0.7, maxDim * 1.5);
        camera.lookAt(width / 2, height / 2, 0);
        cameraRef.current = camera;

        const controls = new OrbitControls(camera, mountRef.current);
        controls.target.set(width / 2, height / 2, 0);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.minDistance = 20;
        controls.maxDistance = 4000;
        controlsRef.current = controls;

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(mountRef.current.clientWidth, mountRef.current.clientHeight);
        renderer.domElement.style.touchAction = 'none';
        mountRef.current.appendChild(renderer.domElement);
        rendererRef.current = renderer;

        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        scene.add(ambientLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight.position.set(100, 100, 100);
        scene.add(directionalLight);

        let animationFrameId = 0;
        const animate = () => {
            animationFrameId = requestAnimationFrame(animate);
            controls.update();
            renderer.render(scene, camera);
        };
        animate();

        const handleResize = () => {
            if (!mountRef.current || !cameraRef.current || !rendererRef.current) return;
            const newWidth = mountRef.current.clientWidth;
            const newHeight = mountRef.current.clientHeight;

            cameraRef.current.aspect = newWidth / newHeight;
            cameraRef.current.updateProjectionMatrix();
            rendererRef.current.setSize(newWidth, newHeight);
        };
        window.addEventListener('resize', handleResize);

        return () => {
            cancelAnimationFrame(animationFrameId);
            window.removeEventListener('resize', handleResize);
            controls.dispose();
            controlsRef.current = null;
            if (mountRef.current && renderer.domElement) {
                mountRef.current.removeChild(renderer.domElement);
            }
            renderer.dispose();
            rendererRef.current = null;
            cameraRef.current = null;
            sceneRef.current = null;
        };
    }, []);

    useEffect(() => {
        if (!sceneRef.current) return;

        sceneRef.current.children = sceneRef.current.children.filter(
            (child: THREE.Object3D) => child.type === 'AmbientLight' ||
                child.type === 'DirectionalLight'
        );

        layout.parts.forEach((part) => {
            const geometry = buildPartGeometry(part, filletOptions);
            const material = new THREE.MeshStandardMaterial({
                color: (part.row + part.col) % 2 === 0 ? 0x595959 : 0x8a8a8a,
                roughness: 0.5,
                metalness: 0.1,
                side: THREE.FrontSide
            });
            sceneRef.current!.add(new THREE.Mesh(geometry, material));

            const outlinePoints = part.outline.map((p) => new THREE.Vector3(p.x, p.y, 0));
            outlinePoints.push(outlinePoints[0].clone());
            const outline = new THREE.Line(
                new THREE.BufferGeometry().setFromPoints(outlinePoints),
                new THREE.LineBasicMaterial({ color: 0x333333, linewidth: 2 })
            );
            outline.position.set(0, 0, -thickness);
            sceneRef.current!.add(outline);
        });
    }, [width, height, thickness, layout, filletOptions]);

    const resetCamera = () => {
        const camera = cameraRef.current;
        const controls = controlsRef.current;
        if (!camera || !controls) return;

        const target = new THREE.Vector3(width / 2, height / 2, 0);
        const verticalFov = THREE.MathUtils.degToRad(camera.fov);
        const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
        const limitingFov = Math.min(verticalFov, horizontalFov);
        const radius = Math.hypot(width, height, thickness) / 2;
        const distance = (radius / Math.sin(limitingFov / 2)) * 1.15;
        const viewDirection = new THREE.Vector3(0.35, 0.35, 1).normalize();

        controls.target.copy(target);
        camera.position.copy(target).addScaledVector(viewDirection, distance);
        controls.update();
    };

    const Logo = () => (
        <svg className="w-8 h-8 md:w-10 md:h-10" viewBox="0 0 1000 1000" xmlns="http://www.w3.org/2000/svg">
            <path fill="#000000" d="M392.438232,73.929527 C334.905548,93.546967 286.036163,126.159508 246.429581,172.262344 C206.917343,218.255417 182.346451,271.288300 172.786514,331.283081 C168.351852,359.113495 168.731567,387.052765 169.776123,415.036591 C169.844788,416.876617 171.137177,419.092743 172.542816,420.400421 C238.180176,481.463989 303.889435,542.450317 369.626587,603.406494 C370.929260,604.614502 372.661163,605.359680 374.277649,606.373962 C307.950836,674.987122 242.808014,742.375427 177.545914,809.887085 C201.769104,833.315979 225.534866,856.302490 249.414154,879.398804 C338.609680,787.136658 427.395538,695.298279 516.320862,603.315674 C514.781616,601.858154 513.591064,600.711182 512.379761,599.586548 C432.513092,525.440063 352.653107,451.286377 272.737183,377.192963 C270.267731,374.903442 268.855957,372.768372 269.104279,369.148895 C270.558716,347.950836 273.752167,327.022552 281.606842,307.248505 C317.356354,217.249481 384.353333,167.247208 479.933746,157.249390 C547.889343,150.141159 608.473389,170.658203 659.339478,216.489380 C706.815613,259.266144 732.323669,313.197113 732.775269,377.378265 C733.508057,481.526398 732.988586,585.683350 733.008301,689.836548 C733.008545,691.264343 733.145081,692.692200 733.209656,693.957397 C766.637146,693.957397 799.586670,693.957397 832.969727,693.957397 C832.969727,691.950134 832.970093,690.161438 832.969604,688.372681 C832.944397,586.884888 832.740723,485.396698 832.974976,383.909546 C833.080261,338.323608 824.710999,294.599365 806.351379,252.886627 C737.474060,96.398132 557.358276,18.474409 392.438232,73.929527 M833.000000,829.500000 C833.000000,815.915710 833.000000,802.331360 833.000000,788.378418 C710.282898,788.378418 588.244751,788.378418 466.294617,788.378418 C466.294617,821.658081 466.294617,854.728088 466.294617,887.713501 C588.653015,887.713501 710.716553,887.713501 833.000000,887.713501 C833.000000,868.451904 833.000000,849.475952 833.000000,829.500000 z" />
        </svg>
    );

    const DownloadIcon = () => (
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
    );

    const generateSTL = () => {
        const build = (part: BoardPart) => buildPartGeometry(part, filletOptions);
        const baseName = `skadis_${width}x${height}x${thickness}mm`;
        const stlBlob = (data: Uint8Array<ArrayBuffer>) => new Blob([data], { type: 'model/stl' });

        if (layout.parts.length === 1) {
            const stl = geometriesToBinaryStl('skadis_pegboard', [
                { geometry: build(layout.parts[0]), dx: -width / 2, dy: -height / 2 }
            ]);
            downloadBlob(stlBlob(stl), `${baseName}.stl`);
            return;
        }

        if (exportMode === 'zip') {
            const files = layout.parts.map((part) => {
                const name = `${baseName}_part_r${part.row + 1}c${part.col + 1}`;
                return {
                    name: `${name}.stl`,
                    content: geometriesToBinaryStl(name, [
                        { geometry: build(part), dx: -part.bbox.minX, dy: -part.bbox.minY }
                    ])
                };
            });
            downloadBlob(createZip(files), `${baseName}_${layout.parts.length}_parts.zip`);
            return;
        }

        // Single STL: keep the assembled grid order but space the parts apart so they are separate bodies.
        const PART_SPACING = 10;
        const cellW = Math.max(...layout.parts.map((p) => p.bbox.maxX - p.bbox.minX)) + PART_SPACING;
        const cellH = Math.max(...layout.parts.map((p) => p.bbox.maxY - p.bbox.minY)) + PART_SPACING;
        const stl = geometriesToBinaryStl(
            'skadis_pegboard_parts',
            layout.parts.map((part) => ({
                geometry: build(part),
                dx: part.col * cellW - part.bbox.minX,
                dy: part.row * cellH - part.bbox.minY
            }))
        );
        downloadBlob(stlBlob(stl), `${baseName}_${layout.parts.length}_parts.stl`);
    };

    const generateSpacerSTL = () => {
        const innerRadius = SCREW_HOLE_DIAMETER / 2;
        const outerRadius = SCREW_HOLE_DIAMETER / 2 + 3;

        let stl = 'solid spacer_10mm\n';

        const addTriangle = (v1: THREE.Vector3, v2: THREE.Vector3, v3: THREE.Vector3) => {
            const normal = new THREE.Vector3()
                .crossVectors(
                    new THREE.Vector3().subVectors(v2, v1),
                    new THREE.Vector3().subVectors(v3, v1)
                )
                .normalize();

            stl += `  facet normal ${normal.x.toFixed(6)} ${normal.y.toFixed(6)} ${normal.z.toFixed(6)}\n`;
            stl += `    outer loop\n`;
            stl += `      vertex ${v1.x.toFixed(6)} ${v1.y.toFixed(6)} ${v1.z.toFixed(6)}\n`;
            stl += `      vertex ${v2.x.toFixed(6)} ${v2.y.toFixed(6)} ${v2.z.toFixed(6)}\n`;
            stl += `      vertex ${v3.x.toFixed(6)} ${v3.y.toFixed(6)} ${v3.z.toFixed(6)}\n`;
            stl += `    endloop\n`;
            stl += `  endfacet\n`;
        };

        const ringShape = new THREE.Shape();
        ringShape.absarc(0, 0, outerRadius, 0, Math.PI * 2, false);

        const holePath = new THREE.Path();
        holePath.absarc(0, 0, innerRadius, 0, Math.PI * 2, true);
        ringShape.holes.push(holePath);

        const extrudeSettings = {
            steps: 1,
            depth: COUNTERSINK_DEPTH,
            bevelEnabled: false
        };

        const geometry = new THREE.ExtrudeGeometry(ringShape, extrudeSettings);
        const positions = geometry.attributes.position.array;
        const indices = geometry.index ? geometry.index.array : null;

        if (indices) {
            for (let i = 0; i < indices.length; i += 3) {
                const v1 = new THREE.Vector3(
                    positions[indices[i] * 3],
                    positions[indices[i] * 3 + 1],
                    positions[indices[i] * 3 + 2]
                );
                const v2 = new THREE.Vector3(
                    positions[indices[i + 1] * 3],
                    positions[indices[i + 1] * 3 + 1],
                    positions[indices[i + 1] * 3 + 2]
                );
                const v3 = new THREE.Vector3(
                    positions[indices[i + 2] * 3],
                    positions[indices[i + 2] * 3 + 1],
                    positions[indices[i + 2] * 3 + 2]
                );
                addTriangle(v1, v2, v3);
            }
        } else {
            for (let i = 0; i < positions.length; i += 9) {
                const v1 = new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]);
                const v2 = new THREE.Vector3(positions[i + 3], positions[i + 4], positions[i + 5]);
                const v3 = new THREE.Vector3(positions[i + 6], positions[i + 7], positions[i + 8]);
                addTriangle(v1, v2, v3);
            }
        }

        stl += 'endsolid spacer_10mm\n';

        const blob = new Blob([stl], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'spacer_10mm.stl';
        a.click();
        URL.revokeObjectURL(url);
    };

    return (
        <div className="w-full h-screen flex flex-col bg-gray-50">
            <div className="bg-white shadow-sm border-b border-gray-200 p-3 md:p-4">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 md:gap-3">
                        <Logo />
                        <div>
                            <h1 className="text-xl md:text-2xl font-bold text-gray-900">Skräddar: IKEA SKÅDIS Pegboard Generator</h1>
                            <p className="text-xs md:text-sm text-gray-600">Create your own IKEA SKÅDIS pegboard for 3D printing</p>
                        </div>
                    </div>
                </div>
            </div>

            <div className="flex flex-1 overflow-hidden flex-col md:flex-row min-h-0">
                <div className="w-full md:w-80 md:flex-shrink-0 bg-white border-b md:border-r md:border-b-0 border-gray-200 p-4 md:p-6 overflow-y-auto max-h-[40vh] md:max-h-none">
                    <h2 className="text-base md:text-lg font-semibold mb-4 text-gray-900">Settings</h2>

                    <div className="space-y-4 md:space-y-6">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                Width: {width}mm
                            </label>
                            <input
                                type="range"
                                min="80"
                                max="800"
                                step="40"
                                value={width}
                                onChange={(e) => setWidth(Number(e.target.value))}
                                className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-black"
                                style={{
                                    background: `linear-gradient(to right, #000 0%, #000 ${((width - 80) / (800 - 80)) * 100}%, #e5e7eb ${((width - 80) / (800 - 80)) * 100}%, #e5e7eb 100%)`
                                }}
                            />
                            <div className="flex justify-between text-xs text-gray-500 mt-1">
                                <span>80mm</span>
                                <span>800mm</span>
                            </div>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                Height: {height}mm
                            </label>
                            <input
                                type="range"
                                min="80"
                                max="800"
                                step="40"
                                value={height}
                                onChange={(e) => setHeight(Number(e.target.value))}
                                className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-black"
                                style={{
                                    background: `linear-gradient(to right, #000 0%, #000 ${((height - 80) / (800 - 80)) * 100}%, #e5e7eb ${((height - 80) / (800 - 80)) * 100}%, #e5e7eb 100%)`
                                }}
                            />
                            <div className="flex justify-between text-xs text-gray-500 mt-1">
                                <span>80mm</span>
                                <span>800mm</span>
                            </div>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                Thickness: {thickness}mm
                            </label>
                            <input
                                type="range"
                                min="2"
                                max="8"
                                step="0.5"
                                value={thickness}
                                onChange={(e) => setThickness(Number(e.target.value))}
                                className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-black"
                                style={{
                                    background: `linear-gradient(to right, #000 0%, #000 ${((thickness - 2) / (8 - 2)) * 100}%, #e5e7eb ${((thickness - 2) / (8 - 2)) * 100}%, #e5e7eb 100%)`
                                }}
                            />
                            <div className="flex justify-between text-xs text-gray-500 mt-1">
                                <span>2mm</span>
                                <span>8mm</span>
                            </div>
                            {thickness !== 5 && (
                                <p className="mt-2 text-xs text-gray-500 italic">
                                    ⚠️ Recommended: 5mm (standard thickness). Deviation may affect hook compatibility.
                                </p>
                            )}
                        </div>

                        {[
                            { label: 'Edge fillet', value: edgeFillet, set: setEdgeFillet, max: MAX_EDGE_FILLET },
                            { label: 'Peg holes fillet', value: holeFillet, set: setHoleFillet, max: MAX_HOLE_FILLET }
                        ].map(({ label, value, set, max }) => (
                            <div key={label}>
                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                    {label}: {value}mm
                                </label>
                                <input
                                    type="range"
                                    min="0"
                                    max={max}
                                    step="0.5"
                                    value={value}
                                    onChange={(e) => set(Number(e.target.value))}
                                    className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-black"
                                    style={{
                                        background: `linear-gradient(to right, #000 0%, #000 ${(value / max) * 100}%, #e5e7eb ${(value / max) * 100}%, #e5e7eb 100%)`
                                    }}
                                />
                                <div className="flex justify-between text-xs text-gray-500 mt-1">
                                    <span>0mm</span>
                                    <span>{max}mm</span>
                                </div>
                                {value > maxFilletForThickness && (
                                    <p className="mt-2 text-xs text-gray-500 italic">
                                        Limited to {maxFilletForThickness}mm (half the thickness).
                                    </p>
                                )}
                            </div>
                        ))}

                        <div className="bg-gray-50 p-3 rounded-lg border border-gray-200 space-y-3">
                            <label className="flex items-start gap-3 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={withMountingHoles}
                                    onChange={(e) => setWithMountingHoles(e.target.checked)}
                                    className="mt-0.5 w-5 h-5 accent-black cursor-pointer flex-shrink-0"
                                />
                                <div>
                                    <span className="text-sm font-medium text-gray-900 block">Add 4 corner holes for mounting</span>
                                </div>
                            </label>
                            {withMountingHoles && (
                                <div className="pl-8">
                                    <label className="block text-sm font-medium text-gray-700 mb-2">
                                        Corner hole chamfer: {cornerHoleChamfer}mm x {cornerHoleChamfer}mm
                                    </label>
                                    <input
                                        type="range"
                                        min="0"
                                        max={MAX_CORNER_CHAMFER}
                                        step="0.5"
                                        value={cornerHoleChamfer}
                                        onChange={(e) => setCornerHoleChamfer(Number(e.target.value))}
                                        className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-black"
                                        style={{
                                            background: `linear-gradient(to right, #000 0%, #000 ${(cornerHoleChamfer / MAX_CORNER_CHAMFER) * 100}%, #e5e7eb ${(cornerHoleChamfer / MAX_CORNER_CHAMFER) * 100}%, #e5e7eb 100%)`
                                        }}
                                    />
                                    <div className="flex justify-between text-xs text-gray-500 mt-1">
                                        <span>0mm</span>
                                        <span>{MAX_CORNER_CHAMFER}mm</span>
                                    </div>
                                    {cornerHoleChamfer > thickness && (
                                        <p className="mt-2 text-xs text-gray-500 italic">
                                            Chamfer depth is limited to the board thickness ({thickness}mm).
                                        </p>
                                    )}
                                </div>
                            )}
                        </div>

                        <div className="bg-gray-50 p-3 rounded-lg border border-gray-200 space-y-3">
                            <label className="flex items-start gap-3 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={splitBoard}
                                    onChange={(e) => setSplitBoard(e.target.checked)}
                                    className="mt-0.5 w-5 h-5 accent-black cursor-pointer flex-shrink-0"
                                />
                                <div>
                                    <span className="text-sm font-medium text-gray-900 block">Split board into printable parts</span>
                                    <span className="text-xs text-gray-500 block">Dovetail seams run between the holes</span>
                                </div>
                            </label>

                            {splitBoard && (
                                <>
                                    <div className="grid grid-cols-2 gap-2">
                                        <label className="text-xs font-medium text-gray-700">
                                            Max part width (mm)
                                            <input
                                                type="number"
                                                min={MIN_PART_SIZE}
                                                step="10"
                                                value={maxPartWidth}
                                                onChange={(e) => setMaxPartWidth(Number(e.target.value))}
                                                className="mt-1 w-full border border-gray-300 rounded px-2 py-1 text-sm"
                                            />
                                        </label>
                                        <label className="text-xs font-medium text-gray-700">
                                            Max part height (mm)
                                            <input
                                                type="number"
                                                min={MIN_PART_SIZE}
                                                step="10"
                                                value={maxPartHeight}
                                                onChange={(e) => setMaxPartHeight(Number(e.target.value))}
                                                className="mt-1 w-full border border-gray-300 rounded px-2 py-1 text-sm"
                                            />
                                        </label>
                                    </div>

                                    <label className="block text-xs font-medium text-gray-700">
                                        Joint clearance (mm)
                                        <input
                                            type="number"
                                            min="0"
                                            max="1"
                                            step="0.05"
                                            value={clearance}
                                            onChange={(e) => setClearance(Math.max(0, Math.min(1, Number(e.target.value))))}
                                            className="mt-1 w-full border border-gray-300 rounded px-2 py-1 text-sm"
                                        />
                                    </label>

                                    <fieldset className="space-y-1">
                                        <legend className="text-xs font-medium text-gray-700 mb-1">Export as</legend>
                                        <label className="flex items-center gap-2 text-sm text-gray-900 cursor-pointer">
                                            <input
                                                type="radio"
                                                name="exportMode"
                                                checked={exportMode === 'zip'}
                                                onChange={() => setExportMode('zip')}
                                                className="accent-black"
                                            />
                                            Separate STL file per part (.zip)
                                        </label>
                                        <label className="flex items-center gap-2 text-sm text-gray-900 cursor-pointer">
                                            <input
                                                type="radio"
                                                name="exportMode"
                                                checked={exportMode === 'single'}
                                                onChange={() => setExportMode('single')}
                                                className="accent-black"
                                            />
                                            One STL, each part a separate body
                                        </label>
                                    </fieldset>

                                    {layout.error ? (
                                        <p className="text-xs text-red-600">{layout.error}</p>
                                    ) : (
                                        <p className="text-xs text-gray-600">
                                            {layout.cols} × {layout.rows} = {layout.parts.length} part{layout.parts.length === 1 ? '' : 's'},
                                            largest {largestPart.w.toFixed(0)} × {largestPart.h.toFixed(0)}mm
                                        </p>
                                    )}
                                </>
                            )}
                        </div>

                        <button
                            onClick={generateSTL}
                            disabled={layout.parts.length === 0}
                            className="w-full bg-black hover:bg-gray-800 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-medium py-3 px-4 rounded-lg transition-colors flex items-center justify-center gap-2"
                        >
                            <DownloadIcon />
                            {layout.parts.length > 1 ? `Download ${layout.parts.length} Parts` : 'Download Pegboard STL'}
                        </button>

                        <button
                            onClick={generateSpacerSTL}
                            className="w-full bg-gray-700 hover:bg-gray-600 text-white font-medium py-3 px-4 rounded-lg transition-colors flex items-center justify-center gap-2"
                        >
                            <DownloadIcon />
                            Download 10mm Spacer STL
                        </button>

                        <p className="text-xs text-gray-500 text-center">
                            Print 4 spacers separately if you added mounting holes.
                        </p>
                    </div>
                </div>

                <div className="flex-1 relative min-h-[300px] md:min-h-0">
                    <div ref={mountRef} className="w-full h-full min-h-[300px]" />
                    <div className="absolute left-3 top-3 rounded bg-white/90 px-3 py-2 text-xs text-gray-600 shadow pointer-events-none">
                        Drag to rotate · Right-drag to pan · Scroll or pinch to zoom
                    </div>
                    <button
                        type="button"
                        onClick={resetCamera}
                        className="absolute right-3 top-3 rounded bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow hover:bg-gray-100"
                    >
                        Reset view
                    </button>
                </div>
            </div>
        </div>
    );
};

export default SkadisGenerator;
