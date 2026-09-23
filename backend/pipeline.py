import argparse
import json
from pathlib import Path
from .engine import analyze
from .demo import create_demo


def main():
    parser = argparse.ArgumentParser(description='Граф денег: воспроизводимый расчёт без внешних API')
    parser.add_argument('--input', type=Path)
    parser.add_argument('--output', type=Path, default=Path('artifacts/cli'))
    parser.add_argument('--demo', action='store_true')
    args = parser.parse_args()
    if not args.input and not args.demo:
        parser.error('Укажите --input с тремя Parquet или --demo')
    source = create_demo(Path('artifacts/demo')) if args.demo else args.input
    result = analyze(source, args.output, 'Синтетический пример' if args.demo else 'Набор кейса', args.demo)
    print(json.dumps({'nodes': result.summary['node_count'], 'seconds': result.summary['elapsed_seconds'],
                     'output': str(args.output.resolve())}, ensure_ascii=True))


if __name__ == '__main__':
    main()
